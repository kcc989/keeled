export { Agent, compileDefinition, createAgent } from './agent.ts';
export type { AgentConfig, AgentDefinition, RunOptions } from './agent.ts';

export { AgentExecution } from './execution.ts';
export { compactHistory, openTurnStart } from './compaction.ts';
export { summaryCompactor } from './summary.ts';
export type { SummaryCompactorOptions } from './summary.ts';
export type {
  CompactedHistory,
  CompactionConfig,
  CompactionContext,
  CompactionOutcome,
  Compactor,
  ResolvedCompaction,
} from './compaction.ts';
export type { RespondAdapter, RespondContext } from './execution.ts';

export { agentTool, agentToolBrand, isAgentTool, registerTools } from './tool.ts';
export type {
  AgentContext,
  AgentTool,
  AgentToolExecutionOptions,
  AgentToolSet,
  AgentToolSpec,
  AgentUIMessage,
  AnyAgentTool,
  InferAgentUITools,
  RegisteredTool,
  SdkToolProjection,
} from './tool.ts';

export { planningTool } from './planning.ts';
export type { PlanningToolOptions } from './planning.ts';

export {
  adoptProposal,
  dependenciesSatisfied,
  parsePlanProposal,
  planProposalSchema,
  planStepProposalSchema,
  readySteps,
} from './plan.ts';
export type { Plan, PlanProposal, PlanStep, StepStatus } from './plan.ts';

export { parseRespondLabel, respondLabels } from './controller.ts';
export type {
  AvailableTool,
  BudgetView,
  Controller,
  ControllerContext,
  ControllerDecision,
  NextAction,
  ProgressAssessment,
  RespondLabel,
} from './controller.ts';

export { emptyState, reduceState, reducerVersion, statusesFor } from './state.ts';
export { digestObservations, digestPlan, digestState, latestRequest, projectMessages } from './projection.ts';
export { GenerationHost } from './generation.ts';

export {
  AgentToolRuntimeError,
  ConfigurationError,
  HarnessError,
  InputResolutionError,
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
  Blocker,
  BlockerRecord,
  CompletionBasis,
  DecisionRecord,
  ExecutionState,
  GoalVerification,
  ManagedGeneration,
  ModelCallOptions,
  Observation,
  PlanRecord,
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
