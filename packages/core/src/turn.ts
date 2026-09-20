import type { UncertainOperation } from './types.ts';
import type { TaskContract } from './task.ts';
import type { InferUIMessageChunk, UIMessageStreamWriterWithOutcome } from 'ai';
import { createId, stableHash } from './ids.ts';
import { errorMessage, isAbortError } from './errors.ts';
import { reduceState } from './state.ts';
import { awaitingConfirmation } from './projection.ts';
import { type AvailableTool, type ControllerContext, type ControllerDecision } from './controller.ts';
import { isJsonValue, type JsonValue } from './json.ts';
import type {
  AgentMessage,
  InspectionRecord,
  BlockerKind,
  BlockerRecord,
  DecisionRecord,
  ExecutionState,
  ResolvedPolicy,
  StopReason,
  TransitionRecord,
  UsageTotals,
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

  get partialText(): string {
    return this.#partialText;
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
    availableTools: readonly AvailableTool[],
    toolCatalog: ControllerContext['toolCatalog'] = availableTools.map((tool) => ({ ...tool, available: true })),
  ): ControllerContext {
    const conversation = this.#conversation();

    return {
      request: this.#options.request,
      instructions: this.#options.instructions,
      conversation,
      state: this.#state,
      availableTools,
      toolCatalog,
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

  recordInspection(inspection: InspectionRecord): void {
    this.#record({ type: 'data-inspection', data: inspection });
  }

  recordOperation(operation: UncertainOperation): void {
    this.#record({ type: 'data-operation', data: operation });
  }

  recordTask(task: TaskContract): void {
    this.#record({ type: 'data-task', data: task });
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

    return record;
  }

  /** Records a tool attempt after its input is known, so different calls stay distinct. */
  recordToolAttempt(tool: string, input: JsonValue): void {
    this.#attempts.push({
      signature: stableHash({ tool, input }),
      evidence: this.#distinctEvidence(),
      exempt: this.#options.isExempt?.(tool) ?? false,
    });
  }

  recordBlocker(
    kind: BlockerKind,
    reason: string,
    resolution: string,
    details?: { tool?: string; input?: JsonValue },
  ): BlockerRecord {
    const record: BlockerRecord = {
      id: createId('blk'),
      cycle: this.#cycle,
      kind,
      tool: details?.tool,
      reason,
      resolution,
    };

    if (details?.input !== undefined) record.input = details.input;

    this.#record({ type: 'data-blocker', id: record.id, data: record });

    return record;
  }

  recordRuntimeError(cause: unknown): void {
    const aborted = isAbortError(cause);
    this.#transition({ kind: aborted ? 'cancelled' : 'error', detail: errorMessage(cause) });
  }

  recordTransition(kind: TransitionRecord['kind'], detail?: string, stopReason?: StopReason): void {
    this.#transition({ kind, detail, stopReason });
  }

  /** One id identifies a transition, as both the part id and the record id. */
  #transition(fields: Omit<TransitionRecord, 'id' | 'cycle'>): void {
    const record: TransitionRecord = { ...fields, id: createId('tr'), cycle: this.#cycle };
    this.#record({ type: 'data-transition', id: record.id, data: record });
  }

  recordToolInput(toolCallId: string, toolName: string, input: JsonValue): void {
    this.#record({ type: 'tool-input-available', toolCallId, toolName, input });
  }

  recordToolInputError(toolCallId: string, toolName: string, input: JsonValue, message: string): void {
    this.#record({ type: 'tool-input-error', toolCallId, toolName, input, errorText: message });
  }

  recordToolOutput(toolCallId: string, output: JsonValue): void {
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
    const attempts = this.#attempts.slice(this.#reportedThrough).filter((attempt) => !attempt.exempt);

    const unchanged = (window: AttemptSignature[]) =>
      window.length > 0 && window.every((attempt) => attempt.evidence === window[0]!.evidence);

    const repeated = attempts.slice(-limit);

    if (
      repeated.length === limit &&
      unchanged(repeated) &&
      repeated.every((attempt) => attempt.signature === repeated[0]!.signature)
    ) {
      return 'repeating';
    }

    const alternated = attempts.slice(-limit * 2);

    if (
      alternated.length === limit * 2 &&
      unchanged(alternated) &&
      new Set(alternated.map((attempt) => attempt.signature)).size === 2
    ) {
      return 'alternating';
    }

    return undefined;
  }

  /** The conversation including the message being written for this turn. */
  get conversation(): AgentMessage[] {
    return this.#conversation();
  }

  /** Distinct domain evidence so far, ignoring identical repeats. */
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

  /** Distinct tool outcomes so far. */
  #distinctEvidence(): number {
    const distinct = new Set<string>();

    for (const observation of this.#state.observations) {
      if (observation.kind === 'tool-result' || observation.kind === 'tool-error') {
        distinct.add(
          stableHash([observation.kind, observation.tool, observation.input, observation.detail, observation.summary]),
        );
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
    case 'data-inspection':
    case 'data-operation':
    case 'data-task':
    case 'data-decision':
    case 'data-blocker':
    case 'data-transition':
      // SAFETY: the adjacent validation or framework contract establishes the asserted type.
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
      // SAFETY: the adjacent validation or framework contract establishes the asserted type.
      return {
        type: `tool-${chunk.toolName}`,
        toolCallId: chunk.toolCallId,
        state: 'input-available',
        input: chunk.input,
      } as AgentMessage['parts'][number];
    case 'tool-input-error':
      // SAFETY: the adjacent validation or framework contract establishes the asserted type.
      return {
        type: `tool-${chunk.toolName}`,
        toolCallId: chunk.toolCallId,
        state: 'output-error',
        input: chunk.input,
        errorText: chunk.errorText,
      } as AgentMessage['parts'][number];
    case 'tool-output-available': {
      const target = findToolPart(parts, chunk.toolCallId);

      if (target !== undefined && isJsonValue(chunk.output)) {
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
  input?: JsonValue;
  output?: JsonValue;
  errorText?: string;
}

function findToolPart(parts: AgentMessage['parts'], toolCallId: string): MutableToolPart | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const candidate = parts[index];

    if (candidate === undefined || !('toolCallId' in candidate) || candidate.toolCallId !== toolCallId) continue;
    // SAFETY: the toolCallId discriminant proves this is a mutable tool stream part.

    return candidate as MutableToolPart;
  }

  return undefined;
}
