import type { LanguageModel } from 'ai';
import { ConfigurationError } from './errors.ts';
import { AgentExecution, type RespondAdapter } from './execution.ts';
import { registerTools, type AgentToolSet, type RegisteredTool } from './tool.ts';
import type { Controller } from './controller.ts';
import type { AgentMessage, AgentPolicy, AgentResult, ResolvedPolicy, Risk } from './types.ts';

export interface AgentConfig<TOOLS extends AgentToolSet> {
  instructions: string;
  controller: Controller;
  model: LanguageModel;
  tools: TOOLS;
  /** Model used to generate tool input when a tool has no input resolver. */
  argumentsModel?: LanguageModel;
  /** Name of the registered tool that creates and revises plans. */
  planningTool?: keyof TOOLS & string;
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
  controller: Controller;
  model: LanguageModel;
  argumentsModel?: LanguageModel;
  tools: TOOLS;
  registry: Map<string, RegisteredTool>;
  planningTool?: string;
  respond?: RespondAdapter;
  policy: ResolvedPolicy;
}

const defaultRisks: readonly Risk[] = ['read', 'write', 'destructive', 'unknown'];

export function compileDefinition<TOOLS extends AgentToolSet>(
  config: AgentConfig<TOOLS>,
): AgentDefinition<TOOLS> {
  if (config.instructions.trim().length === 0) {
    throw new ConfigurationError('Agent instructions must not be empty.');
  }

  const registry = registerTools(config.tools);

  if (config.planningTool !== undefined && !registry.has(config.planningTool)) {
    throw new ConfigurationError(`planningTool "${config.planningTool}" is not a registered tool.`);
  }

  const policy = config.policy ?? {};
  const maxSteps = policy.maxSteps ?? 30;
  if (maxSteps < 1) throw new ConfigurationError('policy.maxSteps must be at least 1.');
  const repeatLimit = policy.repeatLimit ?? 3;
  if (repeatLimit < 2) throw new ConfigurationError('policy.repeatLimit must be at least 2.');
  const floor = policy.inferredConfidenceFloor ?? 0.6;
  if (floor < 0 || floor > 1) {
    throw new ConfigurationError('policy.inferredConfidenceFloor must be between 0 and 1.');
  }

  return {
    instructions: config.instructions,
    controller: config.controller,
    model: config.model,
    argumentsModel: config.argumentsModel,
    tools: config.tools,
    registry,
    planningTool: config.planningTool,
    respond: config.respond,
    policy: {
      maxSteps,
      responseBudget: policy.responseBudget ?? 1,
      repeatLimit,
      maxPlanRevisions: policy.maxPlanRevisions ?? 5,
      toolTimeoutMs: policy.toolTimeoutMs,
      generationTimeoutMs: policy.generationTimeoutMs,
      allowedRisks: new Set(policy.allowedRisks ?? defaultRisks),
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

export function createAgent<const TOOLS extends AgentToolSet>(
  config: AgentConfig<TOOLS>,
): Agent<TOOLS> {
  return new Agent(config);
}
