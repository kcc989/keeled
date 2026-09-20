import { validateInput } from './validation.ts';
import { recover } from './recovery.ts';
import { abortable } from './async.ts';
import { applyTaskPatch } from './task.ts';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { asSchema, jsonSchema, safeValidateTypes } from '@ai-sdk/provider-utils';
import type { ModelMessage, UIMessageStreamOutcome } from 'ai';
import { GenerationHost } from './generation.ts';
import { createId, stableHash } from './ids.ts';
import { MissingInformation, errorMessage, isAbortError } from './errors.ts';
import {
  awaitingConfirmation,
  callHistory,
  presentResult,
  digestObservations,
  latestRequest,
  projectMessages,
} from './projection.ts';
import { Turn, type Writer } from './turn.ts';
import type { AgentContext, AgentToolExecutionOptions, AgentToolSet, RegisteredTool } from './tool.ts';
import type { AvailableTool, ControllerContext, NextAction, PendingAction } from './controller.ts';
import type {
  AgentMessage,
  AgentResult,
  ExecutionState,
  BlockerKind,
  ResolvedPolicy,
  StopReason,
  UsageTotals,
} from './types.ts';
import type { AgentDefinition, RunOptions } from './agent.ts';
import { isJsonValue, type JsonValue } from './json.ts';

type Chunk = Parameters<Writer['write']>[0];

const defaultPollTimeoutMs = 60_000;

async function requiredParameters(tool: RegisteredTool): Promise<string[]> {
  try {
    // SAFETY: the adjacent validation or framework contract establishes the asserted type.
    const schema = (await asSchema(tool.inputSchema).jsonSchema) as { required?: unknown };

    return Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [];
  } catch {
    return [];
  }
}

interface Denial {
  kind: BlockerKind;
  reason: string;
  resolution: string;
}

/** A refusal and what it was decided against, so it is reconsidered when any of that changes. */
interface Refusal {
  denial: Denial;
  /** The instructions it applied. */
  policy: string;
  /** For each result it relied on, the call and that result, so a changed result voids it. */
  cited: { tool: string; input: JsonValue; result: string }[];
  /** Successful state-changing calls when it was made. */
  writes: number;
  /** Distinct evidence when it was made; a refusal for missing evidence yields to any new. */
  evidence: number;
  /** When a time-dependent refusal lapses. */
  expiresAt?: number;
}

const timeSensitiveRefusalMs = 60_000;

interface PermissionVerdict {
  permitted: boolean;
  reason: string;
  /** Evidence that would settle it when the results cannot; empty when they suffice. */
  missing: string;
  /** References of the tool results the verdict relies on. */
  evidence: string[];
  /** The verdict depends on the current time or on state that can change outside the agent. */
  timeSensitive: boolean;
}

const permissionSchema = jsonSchema<PermissionVerdict>({
  type: 'object',
  properties: {
    permitted: { type: 'boolean' },
    reason: { type: 'string' },
    missing: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    timeSensitive: { type: 'boolean' },
  },
  required: ['permitted', 'reason', 'missing', 'evidence', 'timeSensitive'],
  additionalProperties: false,
});

export class AgentExecution<TOOLS extends AgentToolSet> {
  readonly #stream: ReadableStream<Chunk>;
  readonly #result: Promise<AgentResult>;
  #taken = false;

  constructor(definition: AgentDefinition<TOOLS>, options: RunOptions) {
    let settle!: (result: AgentResult) => void;
    let fail!: (cause: unknown) => void;
    this.#result = new Promise<AgentResult>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });

    // SAFETY: the adjacent validation or framework contract establishes the asserted type.
    const originalMessages = [...options.messages] as AgentMessage[];

    const usage: UsageTotals = {
      model: { calls: 0, inputTokens: 0, outputTokens: 0 },
      controller: { calls: 0, inputTokens: 0, outputTokens: 0 },
    };

    let run: ExecutionRun<TOOLS> | undefined;

    this.#stream = createUIMessageStream<AgentMessage>({
      originalMessages,
      onError: (error) => errorMessage(error),
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
  /** Refusals this turn, keyed by call, with the tool evidence they were made against. */
  readonly #refusals = new Map<string, Refusal>();
  readonly #resolutionFailures = new Map<string, { revision: string; reason: string }>();
  #catalog: (AvailableTool & { available: boolean })[] = [];
  readonly #callerSignal: AbortSignal | undefined;
  #deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  #lastCompletionCheck: string | undefined;
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
    this.#callerSignal = options.abortSignal;

    if (this.#policy.turnTimeoutMs !== undefined) {
      this.#deadlineTimer = setTimeout(
        () => this.#abort.abort(new DOMException('Turn deadline exceeded', 'TimeoutError')),
        this.#policy.turnTimeoutMs,
      );
    }

    if (options.abortSignal !== undefined) {
      const forward = () => this.#abort.abort(options.abortSignal?.reason);

      if (options.abortSignal.aborted) forward();
      else options.abortSignal.addEventListener('abort', forward, { once: true });
    }

    this.#request = latestRequest(originalMessages);
    const pollStarted = new Map<string, number>();
    this.#turn = new Turn({
      isExempt: (name) => {
        const tool = definition.registry.get(name);

        if (tool?.repeat !== 'poll') return false;
        const now = Date.now();
        const started = pollStarted.get(name) ?? now;
        pollStarted.set(name, started);

        return now - started < (tool.pollTimeoutMs ?? defaultPollTimeoutMs);
      },
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
      onGeneration: definition.onGeneration,
      usage,
      abortSignal: this.#abort.signal,
      timeoutMs: this.#policy.generationTimeoutMs,
    });
  }

  async execute(): Promise<void> {
    this.#turn.start();
    let outcome: StopReason = 'limit';
    let reportedAtEvidence: number | undefined;
    const resumable = [...awaitingConfirmation(this.#turn.conversation)];

    try {
      const tracker = this.#definition.taskTracker;
      const user = this.#originalMessages.findLast((message) => message.role === 'user');

      if (tracker !== undefined && user !== undefined && !this.#turn.state.task.processedMessages.includes(user.id)) {
        const patch = await abortable(this.#abort.signal, () => tracker.update(this.#agentContext(undefined)));
        this.#turn.recordTask(applyTaskPatch(this.#turn.state.task, patch, user.id, this.#request));
      }

      while (this.#turn.hasWorkBudget()) {
        this.#turn.throwIfAborted();
        this.#turn.beginCycle();

        const resume = resumable.shift();

        if (resume !== undefined) {
          const action: Extract<NextAction, { type: 'tool' }> = {
            type: 'tool',
            tool: resume.tool,
          };

          this.#turn.recordDecision({
            action,
            rationale: 'The runtime resumed the exact action held for confirmation.',
          });
          await this.#callTool(action, { preparedInput: resume.input });
        } else {
          const context = this.#turn.decisionContext(await this.#availableTools(), this.#catalog);
          const control = await abortable(this.#abort.signal, () => this.#definition.controller.control(context));
          const action = this.#normalize(control.action, context);

          this.#turn.recordDecision({ ...control, action });

          if (action.type === 'respond') {
            if (
              action.outcome === 'completed' &&
              this.#turn.state.uncertainOperations.some((operation) => operation.status === 'unknown')
            ) {
              this.#turn.recordBlocker(
                'missing_evidence',
                'A write has an unknown outcome.',
                'Verify the write outcome before declaring completion.',
              );
              outcome = 'blocked';
              break;
            }

            if (action.outcome === 'completed' && !(await this.#verifyCompletion())) {
              if (this.#lastCompletionCheck === this.#evidenceVersion()) {
                outcome = 'blocked';
                break;
              }

              this.#lastCompletionCheck = this.#evidenceVersion();
              continue;
            }

            if (
              action.outcome === 'blocked' ||
              (action.outcome === 'needs_input' &&
                this.#turn.state.blockers.some((b) =>
                  ['invalid_input', 'missing_evidence', 'no_progress'].includes(b.kind),
                ))
            ) {
              const recovery = await this.#recover(action.outcome);

              if (recovery === 'continued') continue;
              outcome = recovery ?? action.outcome;
            } else outcome = action.outcome;
            break;
          }

          await this.#callTool(action);
        }

        // The first report at one evidence state is feedback. Repeating without any new
        // evidence ends the turn. Later evidence permits a fresh recovery attempt.
        const stalled = this.#turn.detectNoProgress();

        if (stalled !== undefined) {
          const recovery = await this.#recover();

          if (recovery === 'continued') continue;

          if (recovery !== undefined) {
            outcome = recovery;
            break;
          }

          const evidence = this.#turn.distinctEvidence();

          if (reportedAtEvidence === evidence) {
            this.#turn.recordBlocker(
              'no_progress',
              `The agent kept ${stalled === 'repeating' ? 'repeating the same action' : 'alternating between two actions'} after being told it was making no progress.`,
              'Respond to the user with what is known.',
            );
            outcome = 'blocked';
            break;
          }

          reportedAtEvidence = evidence;
          this.#turn.markNoProgressReported();
          this.#turn.recordBlocker(
            'no_progress',
            stalled === 'repeating'
              ? 'The same action was repeated without producing any new evidence.'
              : 'Two actions alternated without producing any new evidence.',
            'Choose a different action, or respond with what is known.',
          );
        }
      }
    } catch (error) {
      outcome = this.#callerSignal?.aborted === true ? 'cancelled' : 'error';
      this.#turn.recordRuntimeError(error);
    }

    try {
      await this.#finish(outcome);
    } finally {
      clearTimeout(this.#deadlineTimer);
    }
  }

  result(messages: AgentMessage[], outcome: UIMessageStreamOutcome): AgentResult {
    const stopReason = outcome.status === 'aborted' ? 'cancelled' : this.#stopReason;

    return {
      messages,
      text: this.#turn.partialText,
      stopReason,
      usage: this.#usage,
      // SAFETY: the adjacent validation or framework contract establishes the asserted type.
      state: this.#turn.state as ExecutionState,
      steps: this.#turn.state.stepsUsed,
    };
  }

  // --- decision support -------------------------------------------------

  #normalize(action: NextAction, context: ControllerContext): NextAction {
    if (action.type === 'respond') return action;

    return context.availableTools.some((tool) => tool.name === action.tool)
      ? action
      : { type: 'respond', outcome: 'blocked' };
  }

  /** Conservative revision: observations alone never refill the recovery allowance. */
  async #recover(
    fallback: 'blocked' | 'needs_input' = 'blocked',
  ): Promise<'continued' | 'blocked' | 'needs_input' | undefined> {
    const config = this.#definition.recovery;

    if (config === undefined || !this.#turn.hasWorkBudget()) return undefined;
    const task = this.#turn.state.task;

    const revision = stableHash({
      request: this.#request,
      instructions: this.#definition.instructions,
      goals: task.goals.map(({ text, status }) => ({ text, status })),
      constraints: task.constraints.map(({ text }) => text),
    });

    if (this.#turn.state.recoveryRevisions.includes(revision)) return fallback;
    // Persist and charge before generation, including invalid responses and failed calls.
    this.#turn.recordRecovery(revision);

    try {
      const available = await this.#availableTools();

      const contracts = await Promise.all(
        available.map(async (entry) => ({
          ...entry,
          schema: await asSchema(this.#definition.registry.get(entry.name)!.inputSchema).jsonSchema,
        })),
      );

      const decision = await recover(
        config,
        this.#agentContext(undefined),
        callHistory(this.#turn.conversation, this.#turn.state.observations),
        contracts,
      );

      if (decision.type !== 'call') {
        const reason = decision.type === 'blocked' ? decision.reason : decision.question;
        this.#turn.recordBlocker('missing_evidence', reason, reason);

        return decision.type;
      }

      if (!available.some((tool) => tool.name === decision.tool) || !this.#turn.hasWorkBudget()) return fallback;
      const action = { type: 'tool' as const, tool: decision.tool };
      this.#turn.recordDecision({ action, rationale: 'One stall recovery proposal; normal checks apply.' });
      const before = this.#turn.state.observations.filter((o) => o.kind === 'tool-result').length;
      await this.#callTool(action, { preparedInput: decision.input });

      return this.#turn.state.observations.filter((o) => o.kind === 'tool-result').length > before
        ? 'continued'
        : this.#turn.state.blockers.at(-1)?.kind === 'needs_confirmation'
          ? 'needs_input'
          : fallback;
    } catch (error) {
      if (this.#turn.isAborted() || isAbortError(error)) throw error;
      this.#turn.recordBlocker(
        'no_progress',
        `Recovery failed: ${errorMessage(error)}`,
        'Resolve the blocker before retrying.',
      );

      return fallback;
    }
  }

  // --- tool invocation --------------------------------------------------

  async #callTool(
    action: Extract<NextAction, { type: 'tool' }>,
    callOptions: { preparedInput?: JsonValue } = {},
  ): Promise<void> {
    const tool = this.#definition.registry.get(action.tool);

    if (tool === undefined) {
      this.#turn.recordBlocker(
        'unavailable',
        `Tool "${action.tool}" is not registered.`,
        'Choose one of the available tools, or respond to the user.',
        { tool: action.tool },
      );

      return;
    }

    if (!this.#policy.allowedRisks.has(tool.risk)) {
      this.#turn.recordBlocker(
        'policy_denied',
        `Application policy does not allow tools with risk "${tool.risk}".`,
        'Do not retry it; respond to the user without it.',
        { tool: tool.name },
      );

      return;
    }

    const context = this.#agentContext(action);

    const suspended = this.#resolutionFailures.get(tool.name);

    if (!('preparedInput' in callOptions) && suspended?.revision === this.#resolutionVersion(tool)) {
      this.#turn.recordToolAttempt(tool.name, { unresolved: true });
      this.#turn.recordBlocker(
        'no_progress',
        suspended.reason,
        'Obtain new evidence before resolving this tool again.',
        { tool: tool.name },
      );

      return;
    }

    let input: JsonValue;

    try {
      if ('preparedInput' in callOptions) {
        input = callOptions.preparedInput;
      } else {
        input = await abortable(this.#abort.signal, () => this.#resolveInput(tool, context));
      }
    } catch (error) {
      if (this.#turn.isAborted() || isAbortError(error)) throw error;

      if (error instanceof MissingInformation) {
        this.#resolutionFailures.set(tool.name, { revision: this.#resolutionVersion(tool), reason: error.missing });
        this.#turn.recordToolAttempt(tool.name, { unresolved: true });
        this.#turn.recordBlocker(
          'missing_evidence',
          `${tool.name} cannot be called yet: ${error.missing}`,
          `Obtain it first, from a lookup or from the user: ${error.missing}`,
          { tool: tool.name },
        );

        return;
      }

      this.#resolutionFailures.set(tool.name, { revision: this.#resolutionVersion(tool), reason: errorMessage(error) });
      this.#turn.recordToolAttempt(tool.name, { unresolved: true });
      this.#turn.recordBlocker(
        'invalid_input',
        `Input resolution failed: ${errorMessage(error)}`,
        `Obtain the values ${tool.name} needs, from a lookup or from the user, before calling it again.`,
        { tool: tool.name },
      );

      return;
    }

    const validated = await validateInput(tool, input);

    if (!validated.success) {
      this.#resolutionFailures.set(tool.name, {
        revision: this.#resolutionVersion(tool),
        reason: validated.error.message,
      });
      this.#turn.recordToolAttempt(tool.name, input);
      this.#turn.recordBlocker(
        'invalid_input',
        `Input failed schema validation: ${validated.error.message}`,
        `Call ${tool.name} only with input that matches its schema.`,
        { tool: tool.name, input },
      );

      return;
    }

    if (!isJsonValue(validated.value)) {
      this.#turn.recordBlocker(
        'invalid_input',
        'Input passed its tool schema but is not JSON-serializable.',
        `Call ${tool.name} only with JSON-serializable input.`,
        { tool: tool.name },
      );

      return;
    }

    const validInput = validated.value;
    this.#turn.recordToolAttempt(tool.name, validInput);

    if (tool.repeat === 'reuse' && this.#alreadyReturned(tool.name, validInput)) {
      this.#turn.recordBlocker(
        'duplicate',
        `${tool.name} already returned a result this turn for this exact input: ${JSON.stringify(validInput)}. ` +
          'The tool is marked reusable and no state-changing call has succeeded since.',
        'Use the result already in the call history.',
        { tool: tool.name, input: validInput },
      );

      return;
    }

    if (
      tool.risk !== 'read' &&
      this.#turn.state.uncertainOperations.some((operation) => operation.status === 'unknown')
    ) {
      this.#turn.recordBlocker(
        'policy_denied',
        'A previous write has an unknown outcome.',
        'The outcome must be verified before further writes.',
        { tool: tool.name, input: validInput },
      );

      return;
    }

    const inspection = await abortable(this.#abort.signal, () => tool.inspect?.(structuredClone(validInput), context));

    if (inspection !== undefined)
      this.#turn.recordInspection({
        id: createId('inspection'),
        tool: tool.name,
        input: structuredClone(validInput),
        ...structuredClone(inspection),
      });

    if (inspection !== undefined && inspection.allowed !== true) {
      this.#turn.recordBlocker('policy_denied', inspection.reason, 'Resolve the application check before retrying.', {
        tool: tool.name,
        input: validInput,
      });

      return;
    }

    const denial = await this.#authorize(tool, validInput, inspection);

    if (denial !== undefined) {
      this.#turn.recordBlocker(denial.kind, denial.reason, denial.resolution, {
        tool: tool.name,
        input: validInput,
      });

      return;
    }

    this.#abort.signal.throwIfAborted();
    const toolCallId = createId('call');
    const finalInput = validInput;
    this.#turn.recordToolInput(toolCallId, tool.name, finalInput);

    const options: AgentToolExecutionOptions = {
      ...context,
      toolCallId,
      messages: context.messages,
      context: undefined,
    };

    let output: JsonValue;

    try {
      output = await abortable(this.#abort.signal, () => tool.invoke(finalInput, options));
    } catch (error) {
      if (tool.risk !== 'read')
        this.#turn.recordOperation({
          id: toolCallId,
          tool: tool.name,
          input: finalInput,
          reason: errorMessage(error),
          status: 'unknown',
        });
      this.#turn.recordToolError(toolCallId, errorMessage(error));

      if (this.#turn.isAborted() || isAbortError(error)) throw error;

      return;
    }

    if (tool.outputSchema !== undefined) {
      const checked = await safeValidateTypes({ value: output, schema: tool.outputSchema });

      if (!checked.success) {
        if (tool.risk !== 'read')
          this.#turn.recordOperation({
            id: toolCallId,
            tool: tool.name,
            input: finalInput,
            reason: checked.error.message,
            status: 'unknown',
          });
        this.#turn.recordToolError(toolCallId, `Output failed schema validation: ${checked.error.message}`);

        return;
      }

      if (!isJsonValue(checked.value)) {
        this.#turn.recordToolError(toolCallId, 'Output passed its tool schema but is not JSON-serializable.');

        return;
      }

      output = checked.value;
    }

    this.#turn.recordToolOutput(toolCallId, output);
  }

  /**
   * Asks the controller whether a pending call may run. Unless the controller is confident
   * both that the call is permitted and that no calculation is needed to tell, the model
   * checks the instructions and evidence and its verdict decides. A permitted call still
   * waits for any confirmation the instructions require, and a doubtful confirmation counts
   * as none. Returns the reason when the call may not run.
   */
  async #authorize(
    tool: RegisteredTool,
    input: JsonValue,
    inspection?: import('./tool.ts').InputInspection,
  ): Promise<Denial | undefined> {
    const controller = this.#definition.controller;
    const policy = this.#policy.authorization;

    if (!policy.risks.has(tool.risk) || controller.authorize === undefined) return undefined;

    // A retry of a refused call gets the same answer while what it was decided against holds.
    const key = stableHash({ tool: tool.name, input });
    const refused = this.#refusals.get(key);

    if (refused !== undefined && this.#stillHolds(refused)) return refused.denial;

    const action: PendingAction = {
      tool: tool.name,
      description: tool.description,
      risk: tool.risk,
      input,
      facts: inspection?.facts,
      effects: inspection?.effects,
    };

    const context = this.#turn.decisionContext(await this.#availableTools(), this.#catalog);
    const answer = await abortable(this.#abort.signal, () => controller.authorize!(context, action));

    if (answer.usage !== undefined) this.#turn.accountController(answer.usage);

    const clear =
      answer.permitted.value &&
      answer.permitted.confidence >= policy.permittedFloor &&
      !answer.needsVerification.value &&
      answer.needsVerification.confidence >= policy.verificationFloor;

    const call = `${tool.name} ${JSON.stringify(input)}`;

    const refuse = (denial: Denial, verdict?: PermissionVerdict) => {
      if (denial.kind !== 'needs_confirmation') this.#refusals.set(key, this.#refusal(denial, context, verdict));

      return denial;
    };

    let basis = 'controller';

    if (!clear) {
      const verdict = await this.#verifyPermission(action, context);

      if (!verdict.permitted) {
        const missing = verdict.missing?.trim() ?? '';

        return refuse(
          missing.length > 0
            ? {
                kind: 'missing_evidence',
                reason: `Cannot yet show ${call} is permitted. ${verdict.reason}`,
                resolution: `Obtain this evidence first: ${missing}`,
              }
            : {
                kind: 'policy_denied',
                reason: `Not permitted: ${call}. ${verdict.reason}`,
                resolution:
                  'Do not retry this action; explain the refusal to the user or choose one the policy permits.',
              },
          verdict,
        );
      }

      basis = `verified: ${verdict.reason}`;
    }

    if (!answer.confirmed.value || answer.confirmed.confidence < policy.confirmedFloor) {
      return refuse({
        kind: 'needs_confirmation',
        reason: `Awaiting the user's explicit confirmation: ${call}.`,
        resolution:
          'Describe this exact action to the user and ask them to confirm it; it is checked again before it runs.',
      });
    }

    this.#turn.recordTransition('authorized', `${call} (${basis})`);

    return undefined;
  }

  #refusal(denial: Denial, context: ControllerContext, verdict: PermissionVerdict | undefined): Refusal {
    const history = callHistory(context.conversation, context.observations);

    const cited = (Array.isArray(verdict?.evidence) ? verdict.evidence : [])
      .map((ref) => history.find((call) => call.ref === ref))
      .filter((call) => call !== undefined)
      .map((call) => ({ tool: call.tool, input: call.input, result: stableHash([call.outcome, call.result]) }));

    const refusal: Refusal = {
      denial,
      policy: stableHash(this.#definition.instructions),
      cited,
      writes: this.#successfulWrites(),
      evidence: this.#turn.distinctEvidence(),
    };

    if (verdict?.timeSensitive === true) refusal.expiresAt = Date.now() + timeSensitiveRefusalMs;

    return refusal;
  }

  #stillHolds(refusal: Refusal): boolean {
    if (refusal.policy !== stableHash(this.#definition.instructions)) return false;

    if (refusal.writes !== this.#successfulWrites()) return false;

    if (refusal.expiresAt !== undefined && Date.now() >= refusal.expiresAt) return false;

    if (refusal.denial.kind === 'missing_evidence' && refusal.evidence !== this.#turn.distinctEvidence()) return false;
    const history = callHistory(this.#turn.conversation, this.#turn.state.observations);

    return refusal.cited.every((cited) => {
      const latest = history.findLast(
        (call) => call.tool === cited.tool && stableHash(call.input) === stableHash(cited.input),
      );

      return latest === undefined || stableHash([latest.outcome, latest.result]) === cited.result;
    });
  }

  /** Successful calls this turn that are not read-only, any of which may change state. */
  #successfulWrites(): number {
    return this.#turn.state.observations.filter(
      (observation) =>
        observation.kind === 'tool-result' &&
        (this.#definition.registry.get(observation.tool ?? '')?.risk ?? 'unknown') !== 'read',
    ).length;
  }

  /**
   * Whether a reusable tool already returned a result this turn for this exact input,
   * with no successful call since that is not read-only.
   */
  #alreadyReturned(toolName: string, input: JsonValue): boolean {
    const observations = this.#turn.state.observations;
    const key = stableHash(input);

    const index = observations.findLastIndex(
      (observation) =>
        observation.kind === 'tool-result' && observation.tool === toolName && stableHash(observation.input) === key,
    );

    if (index === -1) return false;

    return !observations
      .slice(index + 1)
      .some(
        (observation) =>
          observation.kind === 'tool-result' &&
          (this.#definition.registry.get(observation.tool ?? '')?.risk ?? 'unknown') !== 'read',
      );
  }

  async #verifyPermission(action: PendingAction, context: ControllerContext): Promise<PermissionVerdict> {
    const calls = callHistory(context.conversation, context.observations)
      .map(
        (call) =>
          `- [${call.ref}] ${call.tool}(${JSON.stringify(call.input)}) ` +
          (call.outcome === 'result'
            ? `returned ${JSON.stringify(presentResult(call.result, call.ref))}`
            : `failed: ${String(call.result)}`),
      )
      .join('\n');

    const result = await this.#generation.generateObject<PermissionVerdict>({
      schema: permissionSchema,
      name: 'permission',
      purpose: 'permission',
      system:
        'You decide whether an agent may take one action now under its instructions. First identify the ' +
        'conditions the instructions set for this kind of action; rules about other kinds of action do not ' +
        'apply to it. Check each applicable condition, including dates, times, amounts, and counts, against ' +
        'the tool results. If an applicable condition is unmet, or the tool results cannot show whether it ' +
        'is met, the action is not permitted. If the instructions set no condition for it, it is permitted. ' +
        'Do not consider whether the user has confirmed the action; that is checked separately.',
      prompt: [
        `Agent instructions:\n${this.#definition.instructions}`,
        `Conversation:\n${projectMessages(context.conversation)
          .map((m) => `${m.role}: ${isTextContent(m.content) ? m.content : ''}`)
          .join('\n')}`,
        `Tool calls so far:\n${calls.length === 0 ? 'None.' : calls}`,
        `Proposed action:\n${action.tool} — ${action.description}\nInput: ${JSON.stringify(action.input)}\nVerified facts: ${JSON.stringify(action.facts)}\nEffects: ${JSON.stringify(action.effects)}\nRetained constraints: ${JSON.stringify(context.state.task.constraints)}`,
        'State whether it is permitted and give the deciding reason in one sentence. If it is not permitted only ' +
          'because the tool results cannot show whether a condition is met, set missing to the evidence that ' +
          'would settle it; otherwise leave missing empty. List in evidence the references, in square brackets ' +
          'above, of the tool results your verdict relies on. Set timeSensitive when the verdict depends on the ' +
          'current time or on state that can change outside the agent.',
      ].join('\n\n'),
      abortSignal: this.#abort.signal,
    });

    return result.object;
  }

  async #resolveInput(tool: RegisteredTool, context: AgentContext): Promise<JsonValue> {
    if (tool.resolveInput !== undefined) {
      return await tool.resolveInput(context);
    }

    const result = await this.#generation.generateObject<JsonValue>({
      schema: tool.inputSchema,
      name: tool.name,
      purpose: 'tool_input',
      description: tool.description,
      model: tool.model ?? this.#definition.argumentsModel ?? this.#definition.model,
      system:
        'You produce the input for a single tool call. Return only values supported by the request and evidence. ' +
        'Never invent user constraints, and never substitute placeholder values for missing required information.',
      prompt: [
        `Agent instructions:\n${this.#definition.instructions}`,
        `Original request:\n${this.#request}`,
        `Tool:\n${tool.name} — ${tool.description}`,
        context.action?.awaitingInput === undefined
          ? ''
          : `Input of this tool's action awaiting the user's confirmation:\n${JSON.stringify(context.action.awaitingInput)}\n` +
            'If the user confirmed it unchanged, return exactly this input.',
        `Conversation:\n${JSON.stringify(projectMessages(context.conversation))}`,
        `Tool calls:\n${JSON.stringify(callHistory(context.conversation, context.state.observations).map((call) => ({ ...call, result: presentResult(call.result, call.ref) })))}`,
        `Evidence:\n${digestObservations(context.state.observations)}`,
        `Retained goals and constraints:\n${JSON.stringify(context.state.task)}`,
        `Application inspections:\n${JSON.stringify(context.state.inspections)}`,
      ]
        .filter((line) => line.length > 0)
        .join('\n\n'),
      abortSignal: this.#abort.signal,
    });

    return result.object;
  }

  #resolutionVersion(tool: RegisteredTool): string {
    return tool.resolutionKey?.(this.#agentContext(undefined)) ?? this.#evidenceVersion();
  }

  #evidenceVersion(): string {
    // A repeated result with a new call ID is not new evidence.
    return stableHash(
      [
        ...new Set(
          callHistory(this.#turn.conversation, this.#turn.state.observations)
            .filter((call) => call.outcome === 'result')
            .map((call) => stableHash([call.tool, call.input, call.result])),
        ),
      ].sort(),
    );
  }

  async #verifyCompletion(): Promise<boolean> {
    const tracker = this.#definition.taskTracker;
    const task = structuredClone(this.#turn.state.task);

    if (tracker === undefined || !task.goals.some((goal) => goal.status === 'pending')) return true;
    const history = callHistory(this.#turn.conversation, this.#turn.state.observations);

    if (this.#lastCompletionCheck === this.#evidenceVersion()) return false;
    const checks = await abortable(this.#abort.signal, () => tracker.verify(this.#agentContext(undefined)));

    for (const check of checks) {
      const goal = task.goals.find((g) => g.id === check.id && g.status === 'pending');

      if (goal === undefined || !check.complete || check.evidence.length === 0) continue;

      const evidence = check.evidence.map((ref) =>
        history.find((call) => call.ref === ref && call.outcome === 'result'),
      );

      if (evidence.some((call) => call === undefined)) continue;

      if (
        goal.requiresWrite &&
        !evidence.some((call) => {
          const sourceTool = this.#definition.registry.get(call!.tool);

          if (sourceTool === undefined || sourceTool.risk === 'read') return false;

          if (call!.turn === 'current') return true;
          const sourceIndex = this.#originalMessages.findIndex((message) => message.id === goal.source);

          const resultIndex = this.#originalMessages.findIndex((message) =>
            message.parts.some((part) => 'toolCallId' in part && part.toolCallId === call!.ref),
          );

          return sourceIndex >= 0 && resultIndex > sourceIndex;
        })
      )
        continue;
      goal.status = 'completed';
      goal.evidence = check.evidence;
    }

    this.#turn.recordTask(task);
    const pending = task.goals.filter((goal) => goal.status === 'pending');

    if (pending.length === 0) return true;
    this.#turn.recordBlocker(
      'missing_evidence',
      `Requested outcomes remain unfinished: ${pending.map((g) => g.text).join('; ')}`,
      'Complete the pending work, ask for required information, or explain the blocker.',
    );

    return false;
  }

  // --- context ----------------------------------------------------------

  #agentContext(action: Extract<NextAction, { type: 'tool' }> | undefined): AgentContext {
    const conversation = [...this.#originalMessages];

    const awaiting =
      action === undefined
        ? undefined
        : awaitingConfirmation(this.#turn.conversation).findLast((held) => held.tool === action.tool);

    const intent =
      action === undefined
        ? undefined
        : {
            tool: action.tool,
            awaitingInput: awaiting?.input,
          };

    return {
      instructions: this.#definition.instructions,
      request: this.#request,
      conversation,
      messages: projectMessages(conversation),
      state: this.#turn.state,
      action: intent,
      abortSignal: this.#abort.signal,
      generateText: this.#generation.generateText,
      generateObject: this.#generation.generateObject,
    };
  }

  async #availableTools(): Promise<AvailableTool[]> {
    const context = this.#agentContext(undefined);
    const tools: AvailableTool[] = [];
    this.#catalog = [];

    // A tool whose call awaits the user's confirmation cannot proceed this turn; asking the
    // user can. Other tools stay available for work that does not depend on it.
    const awaiting = new Set(
      this.#turn.state.blockers
        .filter((blocker) => blocker.kind === 'needs_confirmation')
        .map((blocker) => blocker.tool),
    );

    for (const tool of this.#definition.registry.values()) {
      const available =
        !awaiting.has(tool.name) &&
        (tool.available === undefined || (await abortable(this.#abort.signal, () => tool.available!(context))));

      const catalogEntry = {
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        required: await requiredParameters(tool),
        available,
      };

      this.#catalog.push(catalogEntry);

      if (!available) continue;

      const availableTool: AvailableTool = {
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        required: await requiredParameters(tool),
      };

      const failure = this.#resolutionFailures.get(tool.name);

      if (failure?.revision === this.#resolutionVersion(tool)) availableTool.resolutionBlocked = failure.reason;

      tools.push(availableTool);
    }

    return tools;
  }

  // --- termination ------------------------------------------------------

  async #finish(outcome: StopReason): Promise<void> {
    this.#stopReason = outcome;

    if (outcome === 'cancelled') {
      this.#turn.recordTransition('cancelled', 'Execution was cancelled; partial output is preserved.');
      this.#turn.writeText('This turn was cancelled.');
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

  /** Generate one reply. Reject empty text and tool markup without another model call. */
  async #respond(outcome: StopReason): Promise<string> {
    const responder = this.#definition.respond ?? defaultRespond;

    try {
      const result = await abortable(this.#abort.signal, () =>
        responder({
          request: this.#request,
          instructions: this.#definition.instructions,
          stopReason: outcome,
          state: this.#turn.state,
          conversation: [...this.#originalMessages],
          abortSignal: this.#abort.signal,
          generateText: this.#generation.generateText,
        }),
      );

      const text = result.text.trim();

      return contractViolation(text) === undefined ? text : statusResponse(outcome, this.#turn.state);
    } catch {
      return statusResponse(this.#callerSignal?.aborted === true ? 'cancelled' : outcome, this.#turn.state);
    }
  }
}

function isTextContent(content: ModelMessage['content']): content is string {
  return typeof content === 'string';
}

// Special-token and tool-call syntax from model chat templates. A reply is text for the user;
// it cannot call tools, so any of this means the model tried to and the reply is not an answer.
const toolCallMarkup = [
  /<\/?[|｜][^<>\n]{0,48}[|｜]/,
  /<\/?\s*(tool_call|tool_calls|function_calls?|invoke|tool_use|parameter)\b/i,
  /\{\s*"(name|tool)"\s*:\s*"[^"]+"\s*,\s*"(arguments|parameters|input)"\s*:/,
];

function contractViolation(text: string): string | undefined {
  if (text.length === 0) return 'The previous draft was empty. Write the reply to the user.';

  if (toolCallMarkup.some((pattern) => pattern.test(text))) {
    return (
      'The previous draft contained tool-call markup. This message cannot call tools; nothing it contains ' +
      'is executed. Write only plain text for the user, based on the tool results already available.'
    );
  }

  return undefined;
}

export interface RespondContext {
  request: string;
  instructions: string;
  stopReason: StopReason;
  state: Readonly<ExecutionState>;
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

const defaultRespond: RespondAdapter = async (context) => {
  const result = await context.generateText({
    purpose: 'response',
    system: [
      context.instructions,
      'You write the final message of an agent turn. You have no tools.',
      'Report only what the evidence supports. Never claim work that was not done.',
      outcomeGuidance[context.stopReason],
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
    prompt: [
      `Original request:\n${context.request}`,
      `Outcome: ${context.stopReason}`,
      `Conversation:\n${JSON.stringify(projectMessages(context.conversation))}`,
      `Tool calls:\n${JSON.stringify(callHistory(context.conversation, context.state.observations).map((call) => ({ ...call, result: presentResult(call.result, call.ref) })))}`,
      `Evidence:\n${digestObservations(context.state.observations)}`,
      `Retained goals and constraints:\n${JSON.stringify(context.state.task)}`,
      `Application inspections:\n${JSON.stringify(context.state.inspections)}`,
      context.state.blockers.length === 0
        ? ''
        : `Blockers:\n${context.state.blockers.map((blocker) => `- ${blocker.reason}`).join('\n')}`,
    ]
      .filter((line) => line.length > 0)
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
