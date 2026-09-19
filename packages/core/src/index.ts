export { Agent, compileDefinition, createAgent } from './agent.ts';
export type { AgentConfig, AgentDefinition, RunOptions } from './agent.ts';

export { AgentExecution } from './execution.ts';
export type { RespondAdapter, RespondContext } from './execution.ts';

export { agentTool, agentToolBrand, isAgentTool, registerTools } from './tool.ts';
export type {
  ActionIntent,
  AgentContext,
  AgentTool,
  AgentToolExecutionOptions,
  AgentToolSet,
  AgentToolSpec,
  AgentUIMessage,
  AnyAgentTool,
  InferAgentUITools,
  RegisteredTool,
  RepeatPolicy,
  SdkToolProjection,
} from './tool.ts';

export { planningTool, taskStateTool } from './planning.ts';
export { evidenceTool } from './evidence.ts';
export { candidatesFor, factIndex, factType } from './facts.ts';
export type { Fact, UserStatement } from './facts.ts';
export type { EvidencePage } from './evidence.ts';
export type { PlanningToolOptions } from './planning.ts';

export {
  adoptTaskStateProposal,
  adoptProposal,
  currentGoal,
  dependenciesSatisfied,
  goalProposalSchema,
  implicitTaskState,
  parseTaskStateProposal,
  parsePlanProposal,
  planProposalSchema,
  planStepProposalSchema,
  readySteps,
  taskStateProposalSchema,
} from './plan.ts';
export type {
  Goal,
  GoalStatus,
  KnownFact,
  Plan,
  PlanKind,
  PlanProposal,
  PlanStep,
  StepStatus,
  TaskState,
  TaskStateAdoption,
  TaskStateKind,
  TaskStateProposal,
} from './plan.ts';

export { parseRespondLabel, respondLabels, stepCompleteLabel } from './controller.ts';
export type {
  Authorization,
  AwaitingAction,
  AvailableTool,
  BudgetView,
  Controller,
  ControllerContext,
  ControlResult,
  ControllerDecision,
  Judgement,
  NextAction,
  PendingAction,
  ReplyReview,
  RespondLabel,
} from './controller.ts';

export { emptyState, reduceState, reducerVersion, statusesFor } from './state.ts';
export {
  awaitingConfirmation,
  callHistory,
  defaultResultBudget,
  presentResult,
  digestObservations,
  digestPlan,
  digestTaskState,
  digestState,
  latestRequest,
  projectMessages,
} from './projection.ts';
export type { CallRecord } from './projection.ts';
export { GenerationHost } from './generation.ts';

export {
  AgentToolRuntimeError,
  ConfigurationError,
  HarnessError,
  InputResolutionError,
  MissingInformation,
  PersistenceError,
  PlanValidationError,
  ToolRegistrationError,
} from './errors.ts';

export type {
  AgentDataParts,
  AgentMessage,
  AgentMetadata,
  AgentPolicy,
  AgentResult,
  AuthorizationPolicy,
  Blocker,
  BlockerKind,
  BlockerRecord,
  CompletionBasis,
  DecisionRecord,
  ExecutionState,
  GoalVerification,
  ManagedGeneration,
  ModelCallOptions,
  Observation,
  PlanRecord,
  KnownFactRecord,
  ResolvedPolicy,
  Risk,
  StateCheckpoint,
  StepVerification,
  StopReason,
  TransitionRecord,
  UsageBucket,
  UsageTotals,
  VerificationOutcome,
  VerificationRecord,
  VerificationSummary,
} from './types.ts';
