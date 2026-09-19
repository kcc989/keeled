import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { safeValidateTypes } from '@ai-sdk/provider-utils';
import type { UIMessageStreamOutcome } from 'ai';
import { GenerationHost } from './generation.ts';
import { createId } from './ids.ts';
import { PlanValidationError, errorMessage, isAbortError } from './errors.ts';
import type { Plan } from './plan.ts';
import {
  adoptProposal,
  dependenciesSatisfied,
  parsePlanProposal,
  type PlanProposal,
} from './plan.ts';
import { digestObservations, digestPlan, latestRequest, projectMessages } from './projection.ts';
import { Turn, type Writer } from './turn.ts';
import type { AgentContext, AgentToolExecutionOptions, AgentToolSet, RegisteredTool } from './tool.ts';
import type { AvailableTool, ControllerContext, NextAction } from './controller.ts';
import type {
  AgentMessage,
  AgentResult,
  ExecutionState,
  ResolvedPolicy,
  StopReason,
  UsageTotals,
  VerificationSummary,
} from './types.ts';
import type { AgentDefinition, RunOptions } from './agent.ts';

type Chunk = Parameters<Writer['write']>[0];

export class AgentExecution<TOOLS extends AgentToolSet> {
  readonly #stream: ReadableStream<Chunk>;
  readonly #result: Promise<AgentResult>;
  #taken = false;

  constructor(definition: AgentDefinition<TOOLS>, options: RunOptions) {
    let settle!: (result: AgentResult) => void;
    let fail!: (error: unknown) => void;
    this.#result = new Promise<AgentResult>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });

    const originalMessages = [...options.messages] as AgentMessage[];
    const usage: UsageTotals = {
      model: { calls: 0, inputTokens: 0, outputTokens: 0 },
      controller: { calls: 0, inputTokens: 0, outputTokens: 0 },
    };
    let run: ExecutionRun<TOOLS> | undefined;

    this.#stream = createUIMessageStream<AgentMessage>({
      originalMessages,
      onError: error => errorMessage(error),
      execute: async ({ writer }) => {
        run = new ExecutionRun(definition, options, writer, originalMessages, usage);
        await run.execute();
      },
      onEnd: ({ messages, outcome }) => {
        if (run === undefined) {
          fail(new Error('Execution did not start.'));
          return;
        }
        settle(run.result(messages, outcome));
      },
    });
  }

  /** The AI SDK UI message chunk stream for this execution. */
  get stream(): ReadableStream<Chunk> {
    return this.#take();
  }

  get result(): Promise<AgentResult> {
    return this.#result;
  }

  /** Drains the output without starting another execution. */
  consume(): void {
    const reader = this.#take().getReader();
    const pump = async (): Promise<void> => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    };
    void pump().catch(() => {
      /* consumption errors surface through the result promise */
    });
  }

  toUIMessageStreamResponse(init?: ResponseInit): Response {
    return createUIMessageStreamResponse({ ...init, stream: this.#take() });
  }

  [Symbol.asyncIterator](): AsyncIterator<Chunk> {
    const reader = this.#take().getReader();
    return {
      async next() {
        const { done, value } = await reader.read();
        return done ? { done: true, value: undefined } : { done: false, value };
      },
      async return() {
        await reader.cancel();
        return { done: true, value: undefined };
      },
    };
  }

  #take(): ReadableStream<Chunk> {
    if (this.#taken) {
      throw new Error('This execution has already been consumed. Call agent.stream() again for a new one.');
    }
    this.#taken = true;
    return this.#stream;
  }
}

class ExecutionRun<TOOLS extends AgentToolSet> {
  readonly #definition: AgentDefinition<TOOLS>;
  readonly #policy: ResolvedPolicy;
  readonly #turn: Turn;
  readonly #generation: GenerationHost;
  readonly #abort: AbortController;
  readonly #usage: UsageTotals;
  readonly #request: string;
  readonly #originalMessages: AgentMessage[];
  #stopReason: StopReason = 'limit';

  constructor(
    definition: AgentDefinition<TOOLS>,
    options: RunOptions,
    writer: Writer,
    originalMessages: AgentMessage[],
    usage: UsageTotals,
  ) {
    this.#definition = definition;
    this.#policy = definition.policy;
    this.#usage = usage;
    this.#originalMessages = originalMessages;
    this.#abort = new AbortController();
    if (options.abortSignal !== undefined) {
      const forward = () => this.#abort.abort(options.abortSignal?.reason);
      if (options.abortSignal.aborted) forward();
      else options.abortSignal.addEventListener('abort', forward, { once: true });
    }
    this.#request = latestRequest(originalMessages);
    this.#turn = new Turn({
      request: this.#request,
      instructions: definition.instructions,
      originalMessages,
      policy: this.#policy,
      abortSignal: this.#abort.signal,
      writer,
      usage,
      messageId: createId('msg'),
    });
    this.#generation = new GenerationHost({
      defaultModel: definition.model,
      usage,
      abortSignal: this.#abort.signal,
      timeoutMs: this.#policy.generationTimeoutMs,
    });
  }

  async execute(): Promise<void> {
    this.#turn.start();
    let outcome: StopReason = 'limit';

    try {
      while (this.#turn.hasWorkBudget()) {
        this.#turn.throwIfAborted();
        this.#turn.beginCycle();

        const verification = await this.#verifyProgress();
        const context = this.#turn.decisionContext(verification, await this.#availableTools());
        const decision = await this.#definition.controller.decide(context);
        const action = this.#normalize(decision.action, context);

        this.#turn.recordDecision(
          { ...decision, action },
          action === decision.action ? undefined : { reason: 'Action rejected by the runtime.' },
        );

        if (action.type === 'respond') {
          if (action.outcome === 'completed' && !verification.canComplete) {
            this.#turn.recordBlockedCompletion(verification);
          } else {
            outcome = action.outcome;
            break;
          }
        } else {
          await this.#callTool(action);
        }

        if (this.#turn.isRepeatingWithoutProgress()) {
          this.#turn.recordBlocker('The same action repeated without new evidence.');
          outcome = 'blocked';
          break;
        }
      }
    } catch (error) {
      outcome = this.#turn.isAborted() || isAbortError(error) ? 'cancelled' : 'error';
      this.#turn.recordRuntimeError(error);
    }

    await this.#finish(outcome);
  }

  result(messages: AgentMessage[], outcome: UIMessageStreamOutcome): AgentResult {
    const stopReason = outcome.status === 'aborted' ? 'cancelled' : this.#stopReason;
    return {
      messages,
      text: this.#turn.partialText,
      stopReason,
      usage: this.#usage,
      state: this.#turn.state as ExecutionState,
      plan: this.#turn.plan,
      steps: this.#turn.state.stepsUsed,
    };
  }

  // --- decision support -------------------------------------------------

  async #verifyProgress(): Promise<VerificationSummary> {
    const context = this.#turn.decisionContext(undefined, await this.#availableTools());
    const assessment = await this.#definition.controller.assess(context);
    if (assessment.usage !== undefined) this.#turn.accountController(assessment.usage);

    const floor = this.#policy.inferredConfidenceFloor;
    const plan = this.#turn.plan;
    const planVersion = plan?.version ?? 0;
    const retained = this.#turn.state.verification;
    const steps: VerificationSummary['steps'] = {};

    for (const step of plan?.steps ?? []) {
      const result = assessment.steps[step.id];
      const outcome =
        result === undefined || result.confidence < floor
          ? 'unknown'
          : result.complete
            ? 'passed'
            : 'failed';

      // An assessment that is merely uncertain reports no evidence, so a result already
      // recorded against this plan revision stands. Only new evidence or a plan
      // revision invalidates it.
      const previous = retained[step.id];
      if (outcome === 'unknown' && previous !== undefined && previous.planVersion === planVersion) {
        steps[step.id] = previous;
        continue;
      }

      steps[step.id] = {
        stepId: step.id,
        outcome,
        basis: 'inferred',
        confidence: result?.confidence,
        planVersion,
      };
    }

    const goalOutcome =
      assessment.goalMet.confidence < floor
        ? 'unknown'
        : assessment.goalMet.complete
          ? 'passed'
          : 'failed';

    const retainedGoal = this.#turn.state.goal;
    const goal: VerificationSummary['goal'] =
      goalOutcome === 'unknown' && retainedGoal !== undefined
        ? retainedGoal
        : { outcome: goalOutcome, basis: 'inferred', confidence: assessment.goalMet.confidence };

    const summary: VerificationSummary = {
      steps,
      goal,
      planValid: assessment.planValid.valid,
      planValidConfidence: assessment.planValid.confidence,
      canComplete:
        goal.outcome === 'passed' &&
        Object.values(steps).every(step => step.outcome === 'passed'),
      basis: 'inferred',
    };

    this.#turn.recordVerification(summary);
    return summary;
  }

  #normalize(action: NextAction, context: ControllerContext): NextAction {
    if (action.type === 'respond') return action;

    const available = context.availableTools.some(tool => tool.name === action.tool);
    if (!available) {
      return { type: 'respond', outcome: 'blocked' };
    }

    const plan = context.plan;
    if (action.stepId !== undefined) {
      if (plan === undefined || !plan.steps.some(step => step.id === action.stepId)) {
        return { type: 'tool', tool: action.tool };
      }
      if (!dependenciesSatisfied(plan, action.stepId, context.stepStatuses)) {
        return { type: 'tool', tool: action.tool };
      }
    }
    return action;
  }

  // --- tool invocation --------------------------------------------------

  async #callTool(action: Extract<NextAction, { type: 'tool' }>): Promise<void> {
    const tool = this.#definition.registry.get(action.tool);
    if (tool === undefined) {
      this.#turn.recordBlocker(`Tool "${action.tool}" is not registered.`, { tool: action.tool });
      return;
    }

    if (!this.#policy.allowedRisks.has(tool.risk)) {
      this.#turn.recordBlocker(
        `Application policy does not allow tools with risk "${tool.risk}".`,
        { tool: tool.name, stepId: action.stepId },
      );
      return;
    }

    const context = this.#agentContext(action.stepId);

    let input: unknown;
    try {
      input = await this.#resolveInput(tool, context);
    } catch (error) {
      this.#turn.recordBlocker(`Input resolution failed: ${errorMessage(error)}`, {
        tool: tool.name,
        stepId: action.stepId,
      });
      return;
    }

    const validated = await safeValidateTypes({ value: input, schema: tool.inputSchema });
    if (!validated.success) {
      this.#turn.recordBlocker(`Input failed schema validation: ${validated.error.message}`, {
        tool: tool.name,
        stepId: action.stepId,
      });
      return;
    }

    const toolCallId = createId('call');
    const finalInput = validated.value;
    this.#turn.recordToolInput(toolCallId, tool.name, finalInput);

    const options: AgentToolExecutionOptions = {
      ...context,
      toolCallId,
      messages: context.messages,
      context: undefined,
    };

    let output: unknown;
    try {
      output = await tool.invoke(finalInput, options);
    } catch (error) {
      if (this.#turn.isAborted() || isAbortError(error)) throw error;
      this.#turn.recordToolError(toolCallId, errorMessage(error));
      return;
    }

    if (tool.outputSchema !== undefined) {
      const checked = await safeValidateTypes({ value: output, schema: tool.outputSchema });
      if (!checked.success) {
        this.#turn.recordToolError(toolCallId, `Output failed schema validation: ${checked.error.message}`);
        return;
      }
      output = checked.value;
    }

    this.#turn.recordToolOutput(toolCallId, output);

    if (tool.name === this.#definition.planningTool) {
      this.#adoptPlan(output, toolCallId);
    }
  }

  #adoptPlan(output: unknown, sourceCallId: string): void {
    if (this.#turn.state.planRevisions >= this.#policy.maxPlanRevisions) {
      this.#turn.recordBlocker(
        `The plan revision limit of ${this.#policy.maxPlanRevisions} was reached.`,
      );
      return;
    }

    let proposal: PlanProposal;
    try {
      proposal = parsePlanProposal(output);
    } catch (error) {
      const reason =
        error instanceof PlanValidationError ? error.message : `Invalid plan proposal: ${errorMessage(error)}`;
      this.#turn.recordBlocker(reason, { tool: this.#definition.planningTool });
      return;
    }

    const previousPlan = this.#turn.plan;
    const adoption = adoptProposal(
      proposal,
      previousPlan === undefined
        ? undefined
        : { plan: previousPlan, statuses: this.#turn.stepStatuses },
      () => createId('plan'),
    );

    this.#turn.recordPlan({
      planId: adoption.plan.id,
      version: adoption.plan.version,
      objective: adoption.plan.objective,
      steps: adoption.plan.steps.map(step => ({
        id: step.id,
        objective: step.objective,
        dependencies: [...step.dependencies],
      })),
      sourceCallId,
      previousVersion: previousPlan?.version,
      invalidatedStepIds: adoption.invalidatedStepIds,
      carriedStatuses: adoption.carriedStatuses,
    });
  }

  async #resolveInput(tool: RegisteredTool, context: AgentContext): Promise<unknown> {
    if (tool.resolveInput !== undefined) {
      return await tool.resolveInput(context);
    }
    const result = await this.#generation.generateObject<unknown>({
      schema: tool.inputSchema,
      name: tool.name,
      description: tool.description,
      model: tool.model ?? this.#definition.argumentsModel ?? this.#definition.model,
      system:
        'You produce the input for a single tool call. Return only values supported by the request and evidence. ' +
        'Never invent user constraints, and never substitute placeholder values for missing required information.',
      prompt: [
        `Agent instructions:\n${this.#definition.instructions}`,
        `Original request:\n${this.#request}`,
        `Tool:\n${tool.name} — ${tool.description}`,
        context.stepId === undefined ? '' : `Current plan step: ${context.stepId}`,
        `Plan:\n${digestPlan(context.plan, context.state.stepStatuses)}`,
        `Evidence:\n${digestObservations(context.state.observations)}`,
      ]
        .filter(line => line.length > 0)
        .join('\n\n'),
      abortSignal: this.#abort.signal,
    });
    return result.object;
  }

  // --- context ----------------------------------------------------------

  #agentContext(stepId: string | undefined): AgentContext {
    const conversation = [...this.#originalMessages];
    return {
      instructions: this.#definition.instructions,
      request: this.#request,
      conversation,
      messages: projectMessages(conversation),
      state: this.#turn.state,
      plan: this.#turn.plan,
      stepId,
      abortSignal: this.#abort.signal,
      generateText: this.#generation.generateText,
      generateObject: this.#generation.generateObject,
    };
  }

  async #availableTools(): Promise<AvailableTool[]> {
    const context = this.#agentContext(undefined);
    const tools: AvailableTool[] = [];
    for (const tool of this.#definition.registry.values()) {
      if (tool.available !== undefined && !(await tool.available(context))) continue;
      tools.push({
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        isPlanningTool: tool.name === this.#definition.planningTool,
      });
    }
    return tools;
  }

  // --- termination ------------------------------------------------------

  async #finish(outcome: StopReason): Promise<void> {
    this.#stopReason = outcome;

    if (outcome === 'cancelled') {
      this.#turn.recordTransition('cancelled', 'Execution was cancelled; partial output is preserved.');
      this.#turn.finishMessage('cancelled');
      return;
    }

    if (outcome === 'limit') {
      this.#turn.recordTransition('limit', `The step limit of ${this.#policy.maxSteps} was reached.`);
    }

    const text = await this.#respond(outcome);
    this.#turn.writeText(text);
    this.#turn.finishMessage(outcome);
  }

  async #respond(outcome: StopReason): Promise<string> {
    const context = {
      request: this.#request,
      instructions: this.#definition.instructions,
      stopReason: outcome,
      state: this.#turn.state,
      plan: this.#turn.plan,
      conversation: [...this.#originalMessages],
      abortSignal: this.#abort.signal,
      generateText: this.#generation.generateText,
    };

    try {
      const responder = this.#definition.respond ?? defaultRespond;
      const result = await responder(context);
      const text = result.text.trim();
      return text.length > 0 ? text : statusResponse(outcome, this.#turn.state);
    } catch (error) {
      if (isAbortError(error)) return statusResponse('cancelled', this.#turn.state);
      return statusResponse(outcome, this.#turn.state);
    }
  }
}

export interface RespondContext {
  request: string;
  instructions: string;
  stopReason: StopReason;
  state: Readonly<ExecutionState>;
  plan: Plan | undefined;
  conversation: AgentMessage[];
  abortSignal: AbortSignal;
  generateText: GenerationHost['generateText'];
}

export type RespondAdapter = (context: RespondContext) => Promise<{ text: string }>;

const outcomeGuidance: Record<StopReason, string> = {
  completed: 'The work finished. Answer the request directly using the evidence.',
  needs_input: 'Information is missing. State precisely what you need and why.',
  blocked: 'The work is blocked. Say what blocked it and what would unblock it.',
  limit: 'The step budget ran out. Report what was done and what remains.',
  error: 'A runtime error stopped the work. Report what was done and what failed.',
  cancelled: 'The work was cancelled.',
};

const defaultRespond: RespondAdapter = async context => {
  const result = await context.generateText({
    system: [
      context.instructions,
      'You write the final message of an agent turn. You have no tools.',
      'Report only what the evidence supports. Never claim work that was not done.',
      outcomeGuidance[context.stopReason],
    ].join('\n'),
    prompt: [
      `Original request:\n${context.request}`,
      `Outcome: ${context.stopReason}`,
      `Plan:\n${digestPlan(context.plan, context.state.stepStatuses)}`,
      `Evidence:\n${digestObservations(context.state.observations)}`,
      context.state.blockers.length === 0
        ? ''
        : `Blockers:\n${context.state.blockers.map(blocker => `- ${blocker.reason}`).join('\n')}`,
    ]
      .filter(line => line.length > 0)
      .join('\n\n'),
    abortSignal: context.abortSignal,
  });
  return { text: result.text };
};

function statusResponse(outcome: StopReason, state: Readonly<ExecutionState>): string {
  const blocker = state.blockers.at(-1)?.reason;
  const base: Record<StopReason, string> = {
    completed: 'The requested work finished, but the summary could not be generated.',
    needs_input: 'More information is needed before this request can continue.',
    blocked: 'The work is blocked and could not continue.',
    limit: 'The step budget was reached before the request was finished.',
    error: 'A runtime error stopped this turn.',
    cancelled: 'This turn was cancelled.',
  };
  return blocker === undefined ? base[outcome] : `${base[outcome]} Last blocker: ${blocker}`;
}
