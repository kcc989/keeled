import type { DiscoveryEvaluation, DiscoveryQuestion } from './discovery.ts';
import type {
  AgentMessage,
  Blocker,
  ExecutionState,
  ManagedGeneration,
  Observation,
  Risk,
  UsageBucket,
} from './types.ts';
import type { JsonObject, JsonValue } from './json.ts';
import type { FlexibleSchema } from 'ai';

export interface AvailableTool {
  name: string;
  description: string;
  risk: Risk;
  /** Names of the input's required top-level parameters, so a controller can judge readiness. */
  required: string[];
  /** The registered model-facing input contract. It never exposes execution callbacks. */
  inputSchema: FlexibleSchema<any>;
  /** Ordinary argument resolution is suspended until evidence changes. */
  resolutionBlocked?: string;
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
  /** Full registered catalog, including tools temporarily unavailable for selection. */
  readonly toolCatalog?: readonly (AvailableTool & { available: boolean })[];
  readonly observations: readonly Observation[];
  readonly blockers: readonly Blocker[];
  /** Actions held for confirmation, in this turn or an earlier one, that have not run. */
  readonly awaitingConfirmation: readonly AwaitingAction[];
  readonly budget: BudgetView;
  readonly abortSignal: AbortSignal;
  /** Managed model generation with the run's accounting, timeout, and cancellation. */
  readonly generateToolCalls: ManagedGeneration['generateToolCalls'];
}

export type NextAction<Name extends string = string> =
  | {
      type: 'tool';
      tool: Name;
    }
  | {
      type: 'tool_call';
      tool: Name;
      input: JsonValue;
    }
  | { type: 'respond'; outcome: 'completed' | 'needs_input' | 'blocked' };

/** An action that was held for the user's confirmation and has not run since. */
export interface AwaitingAction {
  tool: string;
  input: JsonValue;
  reason: string;
}

export interface ControllerDecision<Name extends string = string> {
  action: NextAction<Name>;
  rationale?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  usage?: UsageBucket;
}

/** One tool selection or reply. */
export type ControlResult<Name extends string = string> = ControllerDecision<Name>;

/** A tool call whose input is resolved and validated, awaiting authorization to run. */
export interface PendingAction {
  tool: string;
  description: string;
  risk: Risk;
  input: JsonValue;
  facts?: JsonObject;
  effects?: string[];
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

export interface Controller {
  readonly name: string;
  /** Joint controllers supply complete tool calls and cannot use custom input resolvers. */
  readonly inputMode?: 'joint';
  /** Selects the next tool or a reply. */
  control(context: ControllerContext): Promise<ControlResult>;
  /**
   * Judges a pending call before it runs, for risks listed in `policy.authorization.risks`.
   * A controller without it authorizes nothing, and those calls run as before.
   */
  evaluateDiscovery?(question: DiscoveryQuestion, signal: AbortSignal): Promise<DiscoveryEvaluation>;
  authorize?(context: ControllerContext, action: PendingAction): Promise<Authorization>;
}

export const respondLabels = {
  completed: 'respond:completed',
  needs_input: 'respond:needs_input',
  blocked: 'respond:blocked',
} as const;

export type RespondLabel = (typeof respondLabels)[keyof typeof respondLabels];

export function parseRespondLabel(label: string): 'completed' | 'needs_input' | 'blocked' | undefined {
  for (const [outcome, value] of Object.entries(respondLabels)) {
    if (value === label) {
      // SAFETY: Object.entries preserves the three literal keys declared by respondLabels.
      return outcome as 'completed' | 'needs_input' | 'blocked';
    }
  }

  return undefined;
}
