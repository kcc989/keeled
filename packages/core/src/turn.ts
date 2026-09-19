import type { InferUIMessageChunk, UIMessageStreamWriterWithOutcome } from 'ai';
import { createId, stableHash } from './ids.ts';
import { errorMessage, isAbortError } from './errors.ts';
import { implicitPlan, readySteps, type Plan, type StepStatus } from './plan.ts';
import { reduceState, statusesFor } from './state.ts';
import { awaitingConfirmation } from './projection.ts';
import { respondLabels, type AvailableTool, type ControllerContext, type ControllerDecision } from './controller.ts';
import type {
  AgentMessage,
  BlockerKind,
  BlockerRecord,
  DecisionRecord,
  ExecutionState,
  KnownFactRecord,
  PlanRecord,
  ResolvedPolicy,
  StopReason,
  TransitionRecord,
  UsageTotals,
  VerificationRecord,
  VerificationSummary,
} from './types.ts';

type Chunk = InferUIMessageChunk<AgentMessage>;
export type Writer = UIMessageStreamWriterWithOutcome<AgentMessage>;

export interface TurnOptions {
  request: string;
  instructions: string;
  originalMessages: AgentMessage[];
  policy: ResolvedPolicy;
  abortSignal: AbortSignal;
  writer: Writer;
  usage: UsageTotals;
  messageId: string;
  /** Whether an attempt with this tool is exempt from repetition checks, as polling. */
  isExempt?: (tool: string) => boolean;
}

interface AttemptSignature {
  signature: string;
  /** Distinct evidence when the attempt was decided. */
  evidence: number;
  /** A polling attempt within its time limit, which repetition does not count against. */
  exempt: boolean;
}

export class Turn {
  readonly #options: TurnOptions;
  readonly #parts: AgentMessage['parts'] = [];
  readonly #attempts: AttemptSignature[] = [];
  #reportedThrough = 0;
  #state: ExecutionState;
  #finalState: ExecutionState | undefined;
  #cycle = 0;
  #partialText = '';

  constructor(options: TurnOptions) {
    this.#options = options;
    this.#state = reduceState(options.originalMessages);
  }

  /** State for this turn. After the turn ends it is the state as of the last cycle. */
  get state(): Readonly<ExecutionState> {
    return this.#finalState ?? this.#state;
  }

  get cycle(): number {
    return this.#cycle;
  }

  get plan(): Plan | undefined {
    return this.state.plan;
  }

  get partialText(): string {
    return this.#partialText;
  }

  get stepStatuses(): Record<string, StepStatus> {
    return statusesFor(this.state.plan, this.state.stepStatuses);
  }

  hasWorkBudget(): boolean {
    return this.#state.stepsUsed < this.#options.policy.maxSteps;
  }

  isAborted(): boolean {
    return this.#options.abortSignal.aborted;
  }

  throwIfAborted(): void {
    this.#options.abortSignal.throwIfAborted();
  }

  start(): void {
    this.#write({ type: 'start', messageId: this.#options.messageId });
    if (this.#state.plan === undefined) {
      const plan = implicitPlan(this.#options.request, createId('plan'));
      this.recordPlan({
        planId: plan.id,
        version: plan.version,
        kind: plan.kind,
        objective: plan.objective,
        constraints: [...plan.constraints],
        knownFacts: plan.knownFacts.map(fact => ({ ...fact })),
        steps: plan.steps.map(step => ({ ...step })),
        invalidatedStepIds: plan.steps.map(step => step.id),
        carriedStatuses: Object.fromEntries(plan.steps.map(step => [step.id, 'pending' as const])),
      });
    } else {
      this.recordKnownFact({
        id: `fact-user-${this.#options.messageId}`,
        statement: this.#options.request,
        source: 'user',
      });
    }
  }

  beginCycle(): void {
    this.#cycle += 1;
    this.#transition({ kind: 'cycle-start', detail: `Cycle ${this.#cycle}` });
  }

  decisionContext(
    verification: VerificationSummary | undefined,
    availableTools: readonly AvailableTool[],
  ): ControllerContext {
    const conversation = this.#conversation();
    const plan = this.#state.plan;
    const statuses = this.stepStatuses;
    const goal = plan === undefined ? undefined : readySteps(plan, statuses)[0];
    return {
      request: this.#options.request,
      instructions: this.#options.instructions,
      conversation,
      state: this.#state,
      availableTools,
      taskState: plan,
      plan,
      currentGoal: goal,
      currentStep: goal,
      goalStatuses: statuses,
      stepStatuses: statuses,
      verification,
      observations: this.#state.observations,
      blockers: this.#state.blockers,
      awaitingConfirmation: awaitingConfirmation(conversation),
      budget: {
        stepsUsed: this.#state.stepsUsed,
        maxSteps: this.#options.policy.maxSteps,
        remaining: Math.max(0, this.#options.policy.maxSteps - this.#state.stepsUsed),
      },
      abortSignal: this.#options.abortSignal,
    };
  }

  recordDecision(decision: ControllerDecision, overridden?: { reason: string }): DecisionRecord {
    const record: DecisionRecord = {
      id: createId('dec'),
      cycle: this.#cycle,
      action: decision.action,
      rationale: decision.rationale,
      confidence: decision.confidence,
      probabilities: decision.probabilities,
      overridden,
    };
    this.#record({ type: 'data-decision', id: record.id, data: record });
    if (decision.usage !== undefined) this.#accountController(decision.usage);
    if (
      decision.action.type === 'complete_step' ||
      (decision.action.type === 'respond' && decision.action.outcome === 'completed')
    ) {
      this.#pushAttempt(respondLabels.completed, undefined);
    }
    return record;
  }

  /** Records a tool attempt after its input is known, so different calls stay distinct. */
  recordToolAttempt(tool: string, input: unknown, stepId?: string): void {
    this.#attempts.push({
      signature: stableHash({ tool, input, stepId }),
      evidence: this.#distinctEvidence(),
      exempt: this.#options.isExempt?.(tool) ?? false,
    });
  }

  recordVerification(summary: VerificationSummary): void {
    const record: VerificationRecord = {
      id: createId('ver'),
      cycle: this.#cycle,
      planVersion: this.#state.plan?.version,
      summary,
    };
    this.#record({ type: 'data-verification', id: record.id, data: record });
  }

  recordPlan(record: Omit<PlanRecord, 'id' | 'cycle'>): void {
    const full: PlanRecord = { ...record, id: createId('plan'), cycle: this.#cycle };
    this.#record({ type: 'data-plan', id: full.id, data: full });
  }

  recordKnownFact(fact: KnownFactRecord['fact']): void {
    const record: KnownFactRecord = { id: createId('fact'), cycle: this.#cycle, fact };
    this.#record({ type: 'data-fact', id: record.id, data: record });
  }

  recordBlocker(
    kind: BlockerKind,
    reason: string,
    resolution: string,
    details?: { tool?: string; stepId?: string; input?: unknown },
  ): BlockerRecord {
    const record: BlockerRecord = {
      id: createId('blk'),
      cycle: this.#cycle,
      kind,
      tool: details?.tool,
      stepId: details?.stepId,
      ...(details?.input === undefined ? {} : { input: details.input }),
      reason,
      resolution,
    };
    this.#record({ type: 'data-blocker', id: record.id, data: record });
    return record;
  }

  recordBlockedCompletion(verification: VerificationSummary | undefined): void {
    const reasons: string[] = [];
    if (verification !== undefined) {
      for (const [stepId, step] of Object.entries(verification.steps)) {
        if (step.outcome !== 'passed') reasons.push(`step "${stepId}" is ${step.outcome}`);
      }
      if (verification.goal.outcome !== 'passed') {
        reasons.push(`the goal is ${verification.goal.outcome}`);
      }
    }
    const detail =
      reasons.length > 0
        ? `Completion was requested but ${reasons.join(', ')}.`
        : 'Completion was requested but progress does not support it.';
    this.#transition({ kind: 'blocked-completion', detail });
    this.recordBlocker(
      'completion_refused',
      detail,
      'Obtain the evidence the request still needs, or respond that more input is needed or that it cannot be done.',
    );
  }

  recordRuntimeError(error: unknown): void {
    const aborted = this.isAborted() || isAbortError(error);
    this.#transition({ kind: aborted ? 'cancelled' : 'error', detail: errorMessage(error) });
  }

  recordTransition(kind: TransitionRecord['kind'], detail?: string, stopReason?: StopReason): void {
    this.#transition({ kind, detail, stopReason });
  }

  /** One id identifies a transition, as both the part id and the record id. */
  #transition(fields: Omit<TransitionRecord, 'id' | 'cycle'>): void {
    const record: TransitionRecord = { ...fields, id: createId('tr'), cycle: this.#cycle };
    this.#record({ type: 'data-transition', id: record.id, data: record });
  }

  recordToolInput(toolCallId: string, toolName: string, input: unknown): void {
    this.#record({ type: 'tool-input-available', toolCallId, toolName, input });
  }

  recordToolInputError(toolCallId: string, toolName: string, input: unknown, message: string): void {
    this.#record({ type: 'tool-input-error', toolCallId, toolName, input, errorText: message });
  }

  recordToolOutput(toolCallId: string, output: unknown): void {
    this.#record({ type: 'tool-output-available', toolCallId, output });
  }

  recordToolError(toolCallId: string, message: string): void {
    this.#record({ type: 'tool-output-error', toolCallId, errorText: message });
  }

  writeText(text: string, chunkSize = 280): void {
    if (text.length === 0) return;
    const id = createId('txt');
    this.#record({ type: 'text-start', id });
    for (let index = 0; index < text.length; index += chunkSize) {
      const delta = text.slice(index, index + chunkSize);
      this.#partialText += delta;
      this.#record({ type: 'text-delta', id, delta });
    }
    this.#record({ type: 'text-end', id });
  }

  finishMessage(stopReason: StopReason): void {
    const completed = this.#state;
    const checkpoint = {
      reducerVersion: completed.reducerVersion,
      historyPosition: this.#parts.length,
      state: completed,
    };
    this.recordTransition('finish', `Stop reason: ${stopReason}`, stopReason);
    this.#finalState = { ...completed, stopReason };
    const metadata = {
      stopReason,
      usage: this.#options.usage,
      checkpoint,
    };
    this.#write({ type: 'message-metadata', messageMetadata: metadata });
    this.#write({ type: 'finish' });
  }

  /**
   * Whether recent attempts are going nowhere: the same action repeated, or two actions
   * alternating, with no new distinct evidence meanwhile. Identical results and blocked
   * attempts are not evidence. Attempts exempt as polling are ignored, and a window already
   * reported is not reported again.
   */
  detectNoProgress(): 'repeating' | 'alternating' | undefined {
    const limit = this.#options.policy.repeatLimit;
    const attempts = this.#attempts.slice(this.#reportedThrough).filter(attempt => !attempt.exempt);
    const unchanged = (window: AttemptSignature[]) =>
      window.length > 0 && window.every(attempt => attempt.evidence === window[0]!.evidence);

    const repeated = attempts.slice(-limit);
    if (
      repeated.length === limit &&
      unchanged(repeated) &&
      repeated.every(attempt => attempt.signature === repeated[0]!.signature)
    ) {
      return 'repeating';
    }
    const alternated = attempts.slice(-limit * 2);
    if (
      alternated.length === limit * 2 &&
      unchanged(alternated) &&
      new Set(alternated.map(attempt => attempt.signature)).size === 2
    ) {
      return 'alternating';
    }
    return undefined;
  }

  /** The conversation including the message being written for this turn. */
  get conversation(): AgentMessage[] {
    return this.#conversation();
  }

  /** Distinct domain evidence so far, ignoring planning output and identical repeats. */
  distinctEvidence(): number {
    return this.#distinctEvidence();
  }

  /** Starts a fresh window after a report, so the next detection needs new repetition. */
  markNoProgressReported(): void {
    this.#reportedThrough = this.#attempts.length;
  }

  accountController(usage: { calls: number; inputTokens: number; outputTokens: number }): void {
    this.#accountController(usage);
  }

  #accountController(usage: { calls: number; inputTokens: number; outputTokens: number }): void {
    const bucket = this.#options.usage.controller;
    bucket.calls += usage.calls;
    bucket.inputTokens += usage.inputTokens;
    bucket.outputTokens += usage.outputTokens;
  }

  #pushAttempt(tool: string, stepId: string | undefined): void {
    this.#attempts.push({
      signature: stableHash({ tool, stepId }),
      evidence: this.#distinctEvidence(),
      exempt: this.#options.isExempt?.(tool) ?? false,
    });
  }

  /** Distinct tool outcomes so far; planning cannot manufacture progress by revising itself. */
  #distinctEvidence(): number {
    const distinct = new Set<string>();
    for (const observation of this.#state.observations) {
      if (observation.kind === 'tool-result' || observation.kind === 'tool-error') {
        distinct.add(stableHash([observation.kind, observation.tool, observation.input, observation.detail, observation.summary]));
      }
    }
    return distinct.size;
  }

  #conversation(): AgentMessage[] {
    return [...this.#options.originalMessages, this.#currentMessage()];
  }

  #currentMessage(): AgentMessage {
    return { id: this.#options.messageId, role: 'assistant', parts: [...this.#parts] };
  }

  /** Writes a chunk and folds the resulting part into state through the reducer. */
  #record(chunk: Chunk): void {
    this.#write(chunk);
    const part = toPart(chunk, this.#parts);
    if (part !== undefined) this.#parts.push(part);
    this.#state = reduceState(this.#conversation());
  }

  #write(chunk: Chunk): void {
    this.#options.writer.write(chunk);
  }
}

/** Mirrors the SDK's chunk-to-part assembly for the parts this runtime writes. */
function toPart(chunk: Chunk, parts: AgentMessage['parts']): AgentMessage['parts'][number] | undefined {
  switch (chunk.type) {
    case 'data-decision':
    case 'data-plan':
    case 'data-verification':
    case 'data-blocker':
    case 'data-transition':
      return chunk as AgentMessage['parts'][number];
    case 'text-start':
      return { type: 'text', text: '', state: 'streaming' };
    case 'text-delta': {
      const last = parts[parts.length - 1];
      if (last?.type === 'text') last.text += chunk.delta;
      return undefined;
    }
    case 'text-end': {
      const last = parts[parts.length - 1];
      if (last?.type === 'text') last.state = 'done';
      return undefined;
    }
    case 'tool-input-available':
      return {
        type: `tool-${chunk.toolName}`,
        toolCallId: chunk.toolCallId,
        state: 'input-available',
        input: chunk.input,
      } as AgentMessage['parts'][number];
    case 'tool-input-error':
      return {
        type: `tool-${chunk.toolName}`,
        toolCallId: chunk.toolCallId,
        state: 'output-error',
        input: chunk.input,
        errorText: chunk.errorText,
      } as AgentMessage['parts'][number];
    case 'tool-output-available': {
      const target = findToolPart(parts, chunk.toolCallId);
      if (target !== undefined) {
        target.state = 'output-available';
        target.output = chunk.output;
      }
      return undefined;
    }
    case 'tool-output-error': {
      const target = findToolPart(parts, chunk.toolCallId);
      if (target !== undefined) {
        target.state = 'output-error';
        target.errorText = chunk.errorText;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

interface MutableToolPart {
  type: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function findToolPart(parts: AgentMessage['parts'], toolCallId: string): MutableToolPart | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index] as unknown as MutableToolPart | undefined;
    if (part !== undefined && part.toolCallId === toolCallId) return part;
  }
  return undefined;
}
