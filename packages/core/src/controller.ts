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
  readonly budget: BudgetView;
  readonly abortSignal: AbortSignal;
}

export type NextAction<Name extends string = string> =
  | { type: 'tool'; tool: Name; stepId?: string }
  | { type: 'respond'; outcome: 'completed' | 'needs_input' | 'blocked' };

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

export interface Controller {
  readonly name: string;
  decide(context: ControllerContext): Promise<ControllerDecision>;
  assess(context: ControllerContext): Promise<ProgressAssessment>;
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
