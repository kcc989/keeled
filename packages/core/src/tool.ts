import type {
  FlexibleSchema,
  InferSchema,
  InferUITool,
  LanguageModel,
  ModelMessage,
  Tool,
  ToolExecutionOptions,
  ToolSet,
} from 'ai';
import { ToolRegistrationError } from './errors.ts';
import type {
  AgentMessage,
  ExecutionState,
  ManagedGeneration,
  Risk,
  UIToolProjection,
} from './types.ts';
import type { Plan } from './plan.ts';

export const agentToolBrand = Symbol.for('keeled.agent-tool');

export interface AgentContext {
  readonly instructions: string;
  readonly request: string;
  readonly conversation: AgentMessage[];
  readonly messages: ModelMessage[];
  readonly state: Readonly<ExecutionState>;
  readonly plan: Readonly<Plan> | undefined;
  readonly stepId: string | undefined;
  readonly abortSignal: AbortSignal;
  readonly generateText: ManagedGeneration['generateText'];
  readonly generateObject: ManagedGeneration['generateObject'];
}

export interface AgentToolExecutionOptions<CONTEXT = unknown>
  extends Omit<ToolExecutionOptions<CONTEXT>, 'abortSignal' | 'messages'>,
    AgentContext {}

export type AgentAvailability = (context: AgentContext) => boolean | PromiseLike<boolean>;

export interface AgentToolSpec<SCHEMA extends FlexibleSchema<any>, OUTPUT> {
  description: string;
  inputSchema: SCHEMA;
  outputSchema?: FlexibleSchema<OUTPUT>;
  risk?: Risk;
  model?: LanguageModel;
  available?: AgentAvailability;
  resolveInput?: (context: AgentContext) => InferSchema<SCHEMA> | PromiseLike<InferSchema<SCHEMA>>;
  execute: (
    input: InferSchema<SCHEMA>,
    options: AgentToolExecutionOptions,
  ) => OUTPUT | PromiseLike<OUTPUT>;
}

export interface AgentToolExtensions<INPUT, OUTPUT> {
  readonly [agentToolBrand]: true;
  readonly risk: Risk;
  readonly model?: LanguageModel;
  readonly available?: AgentAvailability;
  readonly resolveInput?: (context: AgentContext) => INPUT | PromiseLike<INPUT>;
  readonly execute: (
    input: INPUT,
    options: AgentToolExecutionOptions,
  ) => OUTPUT | PromiseLike<OUTPUT>;
}

export type AgentTool<INPUT = any, OUTPUT = any> = Omit<
  Tool<INPUT, OUTPUT, never>,
  'execute' | 'type'
> & { type?: undefined | 'function' } & AgentToolExtensions<INPUT, OUTPUT>;

/**
 * Defines a tool that runs under this harness. The AI SDK function-tool contract is
 * preserved; only the execution and input-resolution callbacks take the agent context.
 */
export function agentTool<const SCHEMA extends FlexibleSchema<any>, OUTPUT>(
  spec: AgentToolSpec<SCHEMA, OUTPUT>,
): AgentTool<InferSchema<SCHEMA>, Awaited<OUTPUT>> {
  const { risk = 'unknown', ...rest } = spec;
  return { ...rest, risk, [agentToolBrand]: true } as unknown as AgentTool<
    InferSchema<SCHEMA>,
    Awaited<OUTPUT>
  >;
}

export type AnyAgentTool = AgentTool<any, any>;

export type AgentToolSet = Record<string, AnyAgentTool | Tool<any, any, any>>;

export function isAgentTool(tool: unknown): tool is AnyAgentTool {
  return typeof tool === 'object' && tool !== null && agentToolBrand in tool;
}

/** Type-only projection of a registered tool onto the plain SDK tool type. */
type SdkProjection<T> = T extends AgentTool<infer INPUT, infer OUTPUT>
  ? Tool<INPUT, OUTPUT>
  : T;

export type SdkToolProjection<TOOLS extends AgentToolSet> = {
  [NAME in keyof TOOLS]: SdkProjection<TOOLS[NAME]>;
};

/**
 * UI tool types for the registered tool map, for both agent tools and plain SDK tools.
 *
 * The SDK's own `InferUITool` is applied to a type-only SDK projection of each entry, so
 * an agent tool's extended callback signature never has to be callable by an SDK loop.
 */
export type InferAgentUITools<TOOLS extends AgentToolSet> = {
  [NAME in keyof TOOLS & string]: InferUITool<Extract<SdkProjection<TOOLS[NAME]>, Tool>>;
};

export type AgentUIMessage<TOOLS extends AgentToolSet> = AgentMessage<
  InferAgentUITools<TOOLS> extends UIToolProjection ? InferAgentUITools<TOOLS> : UIToolProjection
>;

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: FlexibleSchema<any>;
  outputSchema?: FlexibleSchema<any>;
  risk: Risk;
  model?: LanguageModel;
  kind: 'agent' | 'sdk';
  available?: AgentAvailability;
  resolveInput?: (context: AgentContext) => unknown | PromiseLike<unknown>;
  invoke: (input: unknown, options: AgentToolExecutionOptions) => unknown | PromiseLike<unknown>;
}

const reservedPrefix = 'respond:';

export function registerTools(tools: AgentToolSet): Map<string, RegisteredTool> {
  const registry = new Map<string, RegisteredTool>();

  for (const [name, tool] of Object.entries(tools)) {
    if (name.startsWith(reservedPrefix)) {
      throw new ToolRegistrationError(`Tool name "${name}" uses the reserved "${reservedPrefix}" prefix.`);
    }
    registry.set(name, register(name, tool));
  }

  if (registry.size === 0) {
    throw new ToolRegistrationError('At least one tool must be registered.');
  }
  return registry;
}

function register(name: string, tool: AnyAgentTool | Tool<any, any, any>): RegisteredTool {
  const record = tool as Record<string, unknown>;

  if (record['type'] === 'provider' || record['isProviderExecuted'] === true) {
    throw new ToolRegistrationError(
      `Tool "${name}" is provider-defined or provider-executed. This runtime executes local function tools only.`,
    );
  }
  if (record['type'] === 'dynamic') {
    throw new ToolRegistrationError(
      `Tool "${name}" is a dynamic tool. Dynamic tools are not supported in this phase.`,
    );
  }
  if (record['inputSchema'] === undefined) {
    throw new ToolRegistrationError(`Tool "${name}" has no input schema.`);
  }
  if (typeof record['execute'] !== 'function') {
    throw new ToolRegistrationError(
      `Tool "${name}" has no execute function. This runtime cannot delegate execution to a client.`,
    );
  }

  const description = typeof record['description'] === 'string' ? record['description'] : name;

  if (isAgentTool(tool)) {
    return {
      name,
      description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      risk: tool.risk,
      model: tool.model,
      kind: 'agent',
      available: tool.available,
      resolveInput: tool.resolveInput,
      invoke: (input, options) => tool.execute(input, options),
    };
  }

  const sdkExecute = record['execute'] as (
    input: unknown,
    options: ToolExecutionOptions<unknown>,
  ) => unknown;

  return {
    name,
    description,
    inputSchema: record['inputSchema'] as FlexibleSchema<any>,
    outputSchema: record['outputSchema'] as FlexibleSchema<any> | undefined,
    risk: 'unknown',
    kind: 'sdk',
    invoke: (input, options) =>
      sdkExecute(input, {
        toolCallId: options.toolCallId,
        messages: options.messages,
        abortSignal: options.abortSignal,
        context: options.context,
      }),
  };
}
