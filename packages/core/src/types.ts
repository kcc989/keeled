import type { DiscoveryRecord } from './discovery.ts';
import type { TaskContract } from './task.ts';
import type { JsonObject, JsonValue } from './json.ts';
import type { FlexibleSchema, LanguageModel, ModelMessage, Tool, ToolSet, UIMessage } from 'ai';

export type StopReason = 'completed' | 'needs_input' | 'blocked' | 'limit' | 'error' | 'cancelled';

export type Risk = 'read' | 'write' | 'destructive' | 'unknown';

export interface UsageBucket {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageTotals {
  model: UsageBucket;
  controller: UsageBucket;
}

export interface AgentPolicy {
  maxSteps?: number;
  repeatLimit?: number;
  toolTimeoutMs?: number;
  generationTimeoutMs?: number;
  /** Total deadline for the whole turn, including controller requests. */
  turnTimeoutMs?: number;
  allowedRisks?: readonly Risk[];
  authorization?: AuthorizationPolicy;
  inferredConfidenceFloor?: number;
}

/**
 * Which calls the controller must authorize before they run, and how confident each of its
 * judgements must be. A permission judgement below its floor, or any doubt that verification
 * is unnecessary, escalates to a model check; a confirmation below its floor counts as absent.
 */
export interface AuthorizationPolicy {
  /** Defaults to `write`, `destructive`, and `unknown`. */
  risks?: readonly Risk[];
  /** Defaults to `inferredConfidenceFloor`. */
  permittedFloor?: number;
  /** Defaults to `inferredConfidenceFloor`. */
  verificationFloor?: number;
  /** Defaults to `inferredConfidenceFloor`. */
  confirmedFloor?: number;
}

export interface ResolvedPolicy {
  maxSteps: number;
  repeatLimit: number;
  toolTimeoutMs: number | undefined;
  generationTimeoutMs: number | undefined;
  turnTimeoutMs: number | undefined;
  allowedRisks: ReadonlySet<Risk>;
  authorization: {
    risks: ReadonlySet<Risk>;
    permittedFloor: number;
    verificationFloor: number;
    confirmedFloor: number;
  };
  inferredConfidenceFloor: number;
}

export interface AgentResult {
  /** The complete updated message list. Input messages are not mutated. */
  messages: AgentMessage[];
  /** The new assistant text for this turn. */
  text: string;
  stopReason: StopReason;
  usage: UsageTotals;
  state: ExecutionState;
  steps: number;
}

export interface Observation {
  id: string;
  cycle: number;
  kind: 'tool-result' | 'tool-error' | 'input-error' | 'blocked';
  tool?: string;
  summary: string;
  /** For tool observations, the validated input the call was made with. */
  input?: JsonValue;
  detail?: JsonValue;
}

/**
 * Why an attempt could not proceed. Each kind implies its recovery: a confirmation is
 * obtained by asking the user, missing evidence by a lookup or a question, an invalid input
 * by a different one; a policy denial or unavailable tool is explained rather than retried.
 */
export type BlockerKind =
  | 'needs_confirmation'
  | 'missing_evidence'
  | 'policy_denied'
  | 'invalid_input'
  | 'duplicate'
  | 'unavailable'
  | 'controller_error'
  | 'no_progress';

export interface Blocker {
  id: string;
  cycle: number;
  kind: BlockerKind;
  tool?: string;
  /** The input of the attempt that was blocked, when there was one. */
  input?: JsonValue;
  reason: string;
  /** What would resolve it. */
  resolution: string;
}

export interface InspectionRecord {
  id: string;
  tool: string;
  input: JsonValue;
  allowed: boolean;
  reason: string;
  facts?: JsonObject;
  effects?: string[];
}

export interface ExecutionState {
  reducerVersion: number;
  task: TaskContract;
  uncertainOperations: UncertainOperation[];
  inspections: InspectionRecord[];
  discovery: DiscoveryRecord[];
  cycle: number;
  stepsUsed: number;
  observations: Observation[];
  blockers: Blocker[];
  toolCalls: number;
  stopReason?: StopReason;
}

export interface StateCheckpoint {
  reducerVersion: number;
  historyPosition: number;
  state: ExecutionState;
}

export interface AgentMetadata {
  stopReason?: StopReason;
  usage?: UsageTotals;
  checkpoint?: StateCheckpoint;
}

export interface DecisionRecord {
  id: string;
  cycle: number;
  action:
    | { type: 'tool'; tool: string }
    | { type: 'tool_call'; tool: string; input: JsonValue }
    | { type: 'respond'; outcome: 'completed' | 'needs_input' | 'blocked' };
  rationale?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  overridden?: { reason: string };
}

export interface BlockerRecord extends Blocker {}

export interface TransitionRecord {
  id: string;
  cycle: number;
  kind:
    | 'discovery'
    | 'discovery-error'
    | 'cycle-start'
    | 'controller-error'
    | 'limit'
    | 'cancelled'
    | 'error'
    | 'finish'
    | 'policy-block'
    | 'authorized';
  detail?: string;
  stopReason?: StopReason;
}

export type AgentDataParts = {
  decision: DecisionRecord;
  blocker: BlockerRecord;
  transition: TransitionRecord;
  task: TaskContract;
  operation: UncertainOperation;
  inspection: InspectionRecord;
  discovery: DiscoveryRecord;
};

export type AgentMessage<TOOLS extends UIToolProjection = UIToolProjection> = UIMessage<
  AgentMetadata,
  AgentDataParts,
  TOOLS
>;

export type UIToolProjection = Record<string, { input: JsonValue; output: JsonValue }>;

export interface GenerationTrace {
  purpose: string;
  structured: boolean;
  ms: number;
  status: 'success' | 'error';
  provider?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  error?: string;
  detail?: JsonValue;
}

export interface ModelCallOptions {
  purpose?: string;
  model?: LanguageModel;
  system?: string;
  prompt?: string;
  messages?: ModelMessage[];
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface GeneratedTextResult {
  text: string;
  finishReason: string;
}

export interface GeneratedObjectResult<T> {
  object: T;
  text: string;
}

export interface ModelToolContract {
  name: string;
  description: string;
  inputSchema: FlexibleSchema<any>;
}

export interface GeneratedToolCall {
  tool: string;
  input: unknown;
  invalid?: boolean;
  error?: string;
}

export interface GeneratedToolCallsResult {
  calls: GeneratedToolCall[];
  text: string;
  finishReason: string;
}

export interface ManagedGeneration {
  generateText(options: ModelCallOptions): Promise<GeneratedTextResult>;
  generateObject<OBJECT>(
    options: ModelCallOptions & {
      schema: FlexibleSchema<OBJECT>;
      name?: string;
      description?: string;
    },
  ): Promise<GeneratedObjectResult<OBJECT>>;
  generateToolCalls(
    options: ModelCallOptions & { tools: readonly ModelToolContract[] },
  ): Promise<GeneratedToolCallsResult>;
}

export type PlainTool = Tool<any, any, any>;

export type { ToolSet };

export interface UncertainOperation {
  id: string;
  tool: string;
  input: JsonValue;
  reason: string;
  status: 'unknown' | 'applied' | 'not_applied';
}
