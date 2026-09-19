export { Agent, compileDefinition, createAgent } from './agent.ts';
export type { AgentConfig, AgentDefinition, RunOptions } from './agent.ts';

export { AgentExecution } from './execution.ts';
export type { RespondAdapter, RespondContext } from './execution.ts';

export { agentTool, agentToolBrand, isAgentTool, registerTools } from './tool.ts';
export type {
  ActionIntent,
  CallCandidate,
  CandidateProvider,
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

export { evidenceTool } from './evidence.ts';
export { candidatesFor, factIndex, factType } from './facts.ts';
export type { Fact, UserStatement } from './facts.ts';
export type { EvidencePage } from './evidence.ts';

export { parseRespondLabel, respondLabels } from './controller.ts';
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
  RespondLabel,
} from './controller.ts';

export { emptyState, reduceState, reducerVersion } from './state.ts';
export {
  awaitingConfirmation,
  callHistory,
  defaultResultBudget,
  presentResult,
  digestObservations,
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
  DecisionRecord,
  ExecutionState,
  InspectionRecord,
  ManagedGeneration,
  ModelCallOptions,
  Observation,
  ResolvedPolicy,
  Risk,
  StateCheckpoint,
  StopReason,
  TransitionRecord,
  UsageBucket,
  UsageTotals,
} from './types.ts';

export type { UncertainOperation } from './types.ts';
export type { TaskContract, TaskGoal, TaskItem, TaskPatch, TaskTracker, GoalEvidence } from './task.ts';
export { emptyTask, applyTaskPatch } from './task.ts';
export type { InputInspection } from './tool.ts';

export { calculateDecimals } from './arithmetic.ts';
export { evidenceCalculationTool } from './calculate.ts';

export { modelTaskTracker } from './task-tracker.ts';

export { schemaReadCandidates, type CandidateTool } from './candidates.ts';
