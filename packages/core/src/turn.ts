import type { InferUIMessageChunk, UIMessageStreamWriterWithOutcome } from 'ai';
import { createId, stableHash } from './ids.ts';
import { errorMessage, isAbortError } from './errors.ts';
import { readySteps, type Plan, type StepStatus } from './plan.ts';
import { reduceState, statusesFor } from './state.ts';
import type { AvailableTool, ControllerContext, ControllerDecision } from './controller.ts';
import type {
  AgentMessage,
  BlockerRecord,
  CompactionRecord,
  DecisionRecord,
  ExecutionState,
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
}

interface AttemptSignature {
  signature: string;
  observationCount: number;
}

export class Turn {
  readonly #options: TurnOptions;
  readonly #parts: AgentMessage['parts'] = [];
  readonly #attempts: AttemptSignature[] = [];
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
  }

  beginCycle(): void {
    this.#cycle += 1;
    this.#transition({ kind: 'cycle-start', detail: `Cycle ${this.#cycle}` });
  }

  decisionContext(
    verification: VerificationSummary | undefined,
    availableTools: readonly AvailableTool[],
  ): ControllerContext {
    const plan = this.#state.plan;
    const statuses = this.stepStatuses;
    return {
      request: this.#options.request,
      instructions: this.#options.instructions,
      conversation: this.#conversation(),
      state: this.#state,
      availableTools,
      plan,
      readySteps: plan === undefined ? [] : readySteps(plan, statuses),
      stepStatuses: statuses,
      verification,
      observations: this.#state.observations,
      blockers: this.#state.blockers,
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
    if (decision.action.type === 'tool') {
      this.#pushAttempt(decision.action.tool, decision.action.stepId);
    }
    return record;
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

  recordBlocker(reason: string, details?: { tool?: string; stepId?: string }): BlockerRecord {
    const record: BlockerRecord = {
      id: createId('blk'),
      cycle: this.#cycle,
      tool: details?.tool,
      stepId: details?.stepId,
      reason,
    };
    this.#record({ type: 'data-blocker', id: record.id, data: record });
    return record;
  }

  recordCompaction(record: CompactionRecord): void {
    this.#record({ type: 'data-compaction', id: record.id, data: record });
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
    this.recordBlocker(detail);
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

  isRepeatingWithoutProgress(): boolean {
    const limit = this.#options.policy.repeatLimit;
    if (this.#attempts.length < limit) return false;
    const recent = this.#attempts.slice(-limit);
    const first = recent[0];
    if (first === undefined) return false;
    return recent.every(
      attempt =>
        attempt.signature === first.signature &&
        attempt.observationCount === first.observationCount,
    );
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
      observationCount: this.#state.observations.length,
    });
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
    case 'data-compaction':
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
