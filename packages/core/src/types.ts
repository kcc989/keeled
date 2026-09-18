import type { FlexibleSchema, LanguageModel, ModelMessage, Tool, ToolSet, UIMessage } from 'ai';
import type { Plan, StepStatus } from './plan.ts';

export type StopReason = 'completed' | 'needs_input' | 'blocked' | 'limit' | 'error' | 'cancelled';

export type Risk = 'read' | 'write' | 'destructive' | 'unknown';

export type CompletionBasis = 'verified' | 'inferred';

export type VerificationOutcome = 'passed' | 'failed' | 'unknown';

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
  responseBudget?: number;
  repeatLimit?: number;
  maxPlanRevisions?: number;
  toolTimeoutMs?: number;
  generationTimeoutMs?: number;
  allowedRisks?: readonly Risk[];
  inferredConfidenceFloor?: number;
}

export interface ResolvedPolicy {
  maxSteps: number;
  responseBudget: number;
  repeatLimit: number;
  maxPlanRevisions: number;
  toolTimeoutMs: number | undefined;
  generationTimeoutMs: number | undefined;
  allowedRisks: ReadonlySet<Risk>;
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
  plan?: Plan;
  steps: number;
}

export interface Observation {
  id: string;
  cycle: number;
  kind: 'tool-result' | 'tool-error' | 'input-error' | 'blocked' | 'plan';
  tool?: string;
  stepId?: string;
  summary: string;
  detail?: unknown;
}

export interface Blocker {
  id: string;
  cycle: number;
  tool?: string;
  stepId?: string;
  reason: string;
}

export interface StepVerification {
  stepId: string;
  outcome: VerificationOutcome;
  basis: CompletionBasis;
  confidence?: number;
  planVersion: number;
}

export interface GoalVerification {
  outcome: VerificationOutcome;
  basis: CompletionBasis;
  confidence?: number;
}

export interface VerificationSummary {
  steps: Record<string, StepVerification>;
  goal: GoalVerification;
  planValid: boolean;
  planValidConfidence?: number;
  canComplete: boolean;
  basis: CompletionBasis;
}

export interface ExecutionState {
  reducerVersion: number;
  cycle: number;
  stepsUsed: number;
  plan?: Plan;
  planRevisions: number;
  stepStatuses: Record<string, StepStatus>;
  verification: Record<string, StepVerification>;
  goal?: GoalVerification;
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
  /** Set on a message that replaces earlier messages with a summary. */
  summary?: { replacedMessages: number };
}

export interface DecisionRecord {
  id: string;
  cycle: number;
  action: { type: 'tool'; tool: string; stepId?: string } | { type: 'respond'; outcome: 'completed' | 'needs_input' | 'blocked' };
  rationale?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  overridden?: { reason: string };
}

export interface PlanRecord {
  id: string;
  cycle: number;
  planId: string;
  version: number;
  objective: string;
  steps: { id: string; objective: string; dependencies: string[] }[];
  sourceCallId: string;
  previousVersion?: number;
  invalidatedStepIds: string[];
  carriedStatuses: Record<string, StepStatus>;
}

export interface VerificationRecord {
  id: string;
  cycle: number;
  planVersion?: number;
  summary: VerificationSummary;
}

export interface BlockerRecord extends Blocker {}

export interface TransitionRecord {
  id: string;
  cycle: number;
  kind:
    | 'cycle-start'
    | 'limit'
    | 'cancelled'
    | 'error'
    | 'finish'
    | 'policy-block'
    | 'blocked-completion'
    | 'compaction';
  detail?: string;
  stopReason?: StopReason;
}

export type AgentDataParts = {
  decision: DecisionRecord;
  plan: PlanRecord;
  verification: VerificationRecord;
  blocker: BlockerRecord;
  transition: TransitionRecord;
};

export type AgentMessage<TOOLS extends UIToolProjection = UIToolProjection> = UIMessage<
  AgentMetadata,
  AgentDataParts,
  TOOLS
>;

export type UIToolProjection = Record<string, { input: unknown; output: unknown }>;

export interface ModelCallOptions {
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

export interface ManagedGeneration {
  generateText(options: ModelCallOptions): Promise<GeneratedTextResult>;
  generateObject<OBJECT>(
    options: ModelCallOptions & {
      schema: FlexibleSchema<OBJECT>;
      name?: string;
      description?: string;
    },
  ): Promise<GeneratedObjectResult<OBJECT>>;
}

export type PlainTool = Tool<any, any, any>;

export type { ToolSet };
