import type { RecoveryConfig } from './recovery.ts';
import type { TaskTracker } from './task.ts';
import type { LanguageModel } from 'ai';
import { ConfigurationError } from './errors.ts';
import { AgentExecution, type RespondAdapter } from './execution.ts';
import { registerTools, type AgentToolSet, type RegisteredTool } from './tool.ts';
import type { Controller } from './controller.ts';
import type { AgentMessage, AgentPolicy, AgentResult, ResolvedPolicy, Risk } from './types.ts';

export interface AgentConfig<TOOLS extends AgentToolSet> {
  instructions: string;
  taskTracker?: TaskTracker;
  onGeneration?: (trace: import('./types.ts').GenerationTrace) => void;
  controller: Controller;
  model: LanguageModel;
  tools: TOOLS;
  /** Model used to generate tool input when a tool has no input resolver. */
  argumentsModel?: LanguageModel;
  recovery?: RecoveryConfig;
  /** Replaces the default final-response generator. */
  respond?: RespondAdapter;
  policy?: AgentPolicy;
}

export interface RunOptions {
  messages: AgentMessage[];
  abortSignal?: AbortSignal;
}

export interface AgentDefinition<TOOLS extends AgentToolSet> {
  instructions: string;
  taskTracker?: TaskTracker;
  onGeneration?: (trace: import('./types.ts').GenerationTrace) => void;
  controller: Controller;
  model: LanguageModel;
  argumentsModel?: LanguageModel;
  recovery?: RecoveryConfig;
  tools: TOOLS;
  registry: Map<string, RegisteredTool>;
  respond?: RespondAdapter;
  policy: ResolvedPolicy;
}

const defaultRisks: readonly Risk[] = ['read', 'write', 'destructive', 'unknown'];

const defaultAuthorizeRisks: readonly Risk[] = ['write', 'destructive', 'unknown'];

export function compileDefinition<TOOLS extends AgentToolSet>(config: AgentConfig<TOOLS>): AgentDefinition<TOOLS> {
  if (config.instructions.trim().length === 0) {
    throw new ConfigurationError('Agent instructions must not be empty.');
  }

  if (config.recovery?.maxAttemptsPerRevision !== undefined && config.recovery.maxAttemptsPerRevision !== 1) {
    throw new ConfigurationError('recovery.maxAttemptsPerRevision must be 1.');
  }

  const registry = registerTools(config.tools);

  const policy = config.policy ?? {};
  const maxSteps = policy.maxSteps ?? 30;

  if (maxSteps < 1) throw new ConfigurationError('policy.maxSteps must be at least 1.');
  const repeatLimit = policy.repeatLimit ?? 3;

  if (repeatLimit < 2) throw new ConfigurationError('policy.repeatLimit must be at least 2.');
  const floor = policy.inferredConfidenceFloor ?? 0.6;

  if (floor < 0 || floor > 1) {
    throw new ConfigurationError('policy.inferredConfidenceFloor must be between 0 and 1.');
  }

  const authorization = policy.authorization ?? {};

  const floors = {
    permittedFloor: authorization.permittedFloor ?? floor,
    verificationFloor: authorization.verificationFloor ?? floor,
    confirmedFloor: authorization.confirmedFloor ?? floor,
  };

  for (const [name, value] of Object.entries(floors)) {
    if (value < 0 || value > 1) {
      throw new ConfigurationError(`policy.authorization.${name} must be between 0 and 1.`);
    }
  }

  return {
    instructions: config.instructions,
    taskTracker: config.taskTracker,
    onGeneration: config.onGeneration,
    controller: config.controller,
    model: config.model,
    argumentsModel: config.argumentsModel,
    recovery: config.recovery,
    tools: config.tools,
    registry,
    respond: config.respond,
    policy: {
      maxSteps,
      repeatLimit,
      toolTimeoutMs: policy.toolTimeoutMs,
      generationTimeoutMs: policy.generationTimeoutMs,
      turnTimeoutMs: policy.turnTimeoutMs,
      allowedRisks: new Set(policy.allowedRisks ?? defaultRisks),
      authorization: { risks: new Set(authorization.risks ?? defaultAuthorizeRisks), ...floors },
      inferredConfidenceFloor: floor,
    },
  };
}

export class Agent<TOOLS extends AgentToolSet> {
  readonly #definition: AgentDefinition<TOOLS>;

  constructor(config: AgentConfig<TOOLS>) {
    this.#definition = compileDefinition(config);
  }

  get tools(): TOOLS {
    return this.#definition.tools;
  }

  get definition(): AgentDefinition<TOOLS> {
    return this.#definition;
  }

  /** Runs one turn to completion and returns its result. */
  run(options: RunOptions): Promise<AgentResult> {
    const execution = this.stream(options);
    execution.consume();

    return execution.result;
  }

  /** Starts one execution and exposes its UI stream and final result promise. */
  stream(options: RunOptions): AgentExecution<TOOLS> {
    return new AgentExecution(this.#definition, options);
  }
}

export function createAgent<const TOOLS extends AgentToolSet>(config: AgentConfig<TOOLS>): Agent<TOOLS> {
  return new Agent(config);
}
