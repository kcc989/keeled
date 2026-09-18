import type { Plan, PlanStep, StepStatus } from './plan.ts';
import type {
  AgentMessage,
  Blocker,
  ExecutionState,
  Observation,
  Risk,
  UsageBucket,
  VerificationSummary,
} from './types.ts';

export interface AvailableTool {
  name: string;
  description: string;
  risk: Risk;
  isPlanningTool: boolean;
}

export interface BudgetView {
  stepsUsed: number;
  maxSteps: number;
  remaining: number;
}

export interface ControllerContext {
  readonly request: string;
  readonly instructions: string;
  readonly conversation: readonly AgentMessage[];
  readonly state: Readonly<ExecutionState>;
  readonly availableTools: readonly AvailableTool[];
  readonly plan: Readonly<Plan> | undefined;
  readonly readySteps: readonly PlanStep[];
  readonly stepStatuses: Readonly<Record<string, StepStatus>>;
  readonly verification: VerificationSummary | undefined;
  readonly observations: readonly Observation[];
  readonly blockers: readonly Blocker[];
  /** Actions held for confirmation, in this turn or an earlier one, that have not run. */
  readonly awaitingConfirmation: readonly AwaitingAction[];
  readonly budget: BudgetView;
  readonly abortSignal: AbortSignal;
}

export type NextAction<Name extends string = string> =
  | {
      type: 'tool';
      tool: Name;
      stepId?: string;
      /** What the call is meant to establish, carried to input resolution. */
      objective?: string;
      /** References of earlier results the call builds on or should not repeat. */
      evidence?: string[];
    }
  | { type: 'respond'; outcome: 'completed' | 'needs_input' | 'blocked' };

/** An action that was held for the user's confirmation and has not run since. */
export interface AwaitingAction {
  tool: string;
  input: unknown;
  reason: string;
}

export interface ControllerDecision<Name extends string = string> {
  action: NextAction<Name>;
  rationale?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  usage?: UsageBucket;
}

export interface ProgressAssessment {
  steps: Record<string, { complete: boolean; confidence: number }>;
  goalMet: { complete: boolean; confidence: number };
  planValid: { valid: boolean; confidence: number };
  usage?: UsageBucket;
}

/** A tool call whose input is resolved and validated, awaiting authorization to run. */
export interface PendingAction {
  tool: string;
  description: string;
  risk: Risk;
  input: unknown;
  stepId?: string;
}

export interface Judgement {
  value: boolean;
  confidence: number;
}

export interface Authorization {
  /** The instructions and evidence clearly permit the action. */
  permitted: Judgement;
  /** Deciding whether it is permitted needs calculation or detailed comparison. */
  needsVerification: Judgement;
  /** Any confirmation the instructions require for the action has been given. */
  confirmed: Judgement;
  usage?: UsageBucket;
}

export interface ReplyReview {
  /** The reply addresses everything the latest message asked, or says why it cannot. */
  addressesRequest: Judgement;
  /** Every outcome the reply states is supported by the tool results. */
  supported: Judgement;
  usage?: UsageBucket;
}

export interface Controller {
  readonly name: string;
  decide(context: ControllerContext): Promise<ControllerDecision>;
  assess(context: ControllerContext): Promise<ProgressAssessment>;
  /**
   * Judges a pending call before it runs, for risks listed in `policy.authorizeRisks`.
   * A controller without it authorizes nothing, and those calls run as before.
   */
  authorize?(context: ControllerContext, action: PendingAction): Promise<Authorization>;
  /** Reviews a drafted reply before it is sent. Without it, only the output contract is checked. */
  reviewReply?(context: ControllerContext, reply: string): Promise<ReplyReview>;
}

export const respondLabels = {
  completed: 'respond:completed',
  needs_input: 'respond:needs_input',
  blocked: 'respond:blocked',
} as const;

export type RespondLabel = (typeof respondLabels)[keyof typeof respondLabels];

export function parseRespondLabel(label: string): 'completed' | 'needs_input' | 'blocked' | undefined {
  for (const [outcome, value] of Object.entries(respondLabels)) {
    if (value === label) return outcome as 'completed' | 'needs_input' | 'blocked';
  }
  return undefined;
}
