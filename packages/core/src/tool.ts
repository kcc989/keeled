import type {
  FlexibleSchema,
  InferSchema,
  InferUITool,
  LanguageModel,
  ModelMessage,
  Tool,
  ToolExecutionOptions,
} from 'ai';
import { ToolRegistrationError } from './errors.ts';
import type { JsonObject, JsonValue } from './json.ts';
import { isJsonValue } from './json.ts';
import type { AgentMessage, ExecutionState, ManagedGeneration, Risk, UIToolProjection } from './types.ts';

export const agentToolBrand = Symbol.for('keeled.agent-tool');

/** What the controller selected a tool call for, carried into its input resolution. */
export interface ActionIntent {
  tool: string;
  /** Input of the same tool's action held for the user's confirmation, if any. */
  awaitingInput?: JsonValue;
}

export interface InputInspection {
  /** Deterministic, application-owned checks; denial cannot be overruled by a model. */
  allowed: boolean;
  reason: string;
  facts?: JsonObject;
  effects?: string[];
}

export interface AgentContext {
  readonly instructions: string;
  readonly request: string;
  readonly conversation: AgentMessage[];
  readonly messages: ModelMessage[];
  readonly state: Readonly<ExecutionState>;
  /** The action being resolved or executed, as the controller selected it. */
  readonly action: ActionIntent | undefined;
  readonly abortSignal: AbortSignal;
  readonly generateText: ManagedGeneration['generateText'];
  readonly generateObject: ManagedGeneration['generateObject'];
}

export interface AgentToolExecutionOptions<CONTEXT = unknown>
  extends Omit<ToolExecutionOptions<CONTEXT>, 'abortSignal' | 'messages'>, AgentContext {}

export type AgentAvailability = (context: AgentContext) => boolean | PromiseLike<boolean>;

/**
 * How the runtime may treat repeated calls within one turn. `allow` runs every call, and a
 * tool repeated with no new evidence is reported as making no progress. `reuse` declares
 * that a result stays valid until a state-changing call succeeds, so an identical repeat
 * before then is not run and the agent is pointed at the result it already has. `poll`
 * declares that repeating is the point, as when waiting on external state: repetition is
 * not held against it until `pollTimeoutMs` has passed since its first call in the turn.
 */
export type RepeatPolicy = 'allow' | 'reuse' | 'poll';

/** A complete, evidence-backed input offered for controller selection. */
export interface CallCandidate<INPUT = JsonValue> {
  input: INPUT;
  description: string;
  sources: readonly string[];
}

export type CandidateProvider<INPUT = JsonValue> = (
  context: AgentContext,
) => readonly CallCandidate<INPUT>[] | PromiseLike<readonly CallCandidate<INPUT>[]>;

export interface AgentToolSpec<SCHEMA extends FlexibleSchema<any>, OUTPUT> {
  description: string;
  inputSchema: SCHEMA;
  outputSchema?: FlexibleSchema<OUTPUT>;
  risk?: Risk;
  /** Defaults to `allow`. */
  repeat?: RepeatPolicy;
  /** For `poll` tools, how long repetition is exempt from progress checks. Defaults to 60 seconds. */
  pollTimeoutMs?: number;
  model?: LanguageModel;
  available?: AgentAvailability;
  /** Optional ready-call builder. Only read tools may offer candidates. */
  candidates?: CandidateProvider<InferSchema<SCHEMA>>;
  /** Optional application evidence version for argument resolution. User-turn changes always invalidate it. */
  resolutionKey?: (context: AgentContext) => string;
  inspect?: (input: InferSchema<SCHEMA>, context: AgentContext) => InputInspection | PromiseLike<InputInspection>;
  resolveInput?: (context: AgentContext) => InferSchema<SCHEMA> | PromiseLike<InferSchema<SCHEMA>>;
  execute: (input: InferSchema<SCHEMA>, options: AgentToolExecutionOptions) => OUTPUT | PromiseLike<OUTPUT>;
}

export interface AgentToolExtensions<INPUT, OUTPUT> {
  readonly [agentToolBrand]: true;
  readonly risk: Risk;
  readonly repeat: RepeatPolicy;
  readonly pollTimeoutMs?: number;
  readonly model?: LanguageModel;
  readonly available?: AgentAvailability;
  readonly candidates?: CandidateProvider<INPUT>;
  readonly resolutionKey?: (context: AgentContext) => string;
  readonly inspect?: (input: INPUT, context: AgentContext) => InputInspection | PromiseLike<InputInspection>;
  readonly resolveInput?: (context: AgentContext) => INPUT | PromiseLike<INPUT>;
  readonly execute: (input: INPUT, options: AgentToolExecutionOptions) => OUTPUT | PromiseLike<OUTPUT>;
}

export type AgentTool<INPUT = any, OUTPUT = any> = Omit<Tool<INPUT, OUTPUT, never>, 'execute' | 'type'> & {
  type?: undefined | 'function';
} & AgentToolExtensions<INPUT, OUTPUT>;

/**
 * Defines a tool that runs under this harness. The AI SDK function-tool contract is
 * preserved; only the execution and input-resolution callbacks take the agent context.
 */
export function agentTool<const SCHEMA extends FlexibleSchema<any>, OUTPUT>(
  spec: AgentToolSpec<SCHEMA, OUTPUT>,
): AgentTool<InferSchema<SCHEMA>, Awaited<OUTPUT>> {
  const { risk = 'unknown', repeat = 'allow', ...rest } = spec;

  // SAFETY: this constructor supplies every AgentTool extension while preserving the SDK fields from spec.
  return { ...rest, risk, repeat, [agentToolBrand]: true } as AgentTool<InferSchema<SCHEMA>, Awaited<OUTPUT>>;
}

export type AnyAgentTool = AgentTool<any, any>;

export type AgentToolSet = Record<string, AnyAgentTool | Tool<any, any, any>>;

export function isAgentTool(tool: AnyAgentTool | Tool<any, any, any>): tool is AnyAgentTool {
  return typeof tool === 'object' && tool !== null && agentToolBrand in tool;
}

/** Type-only projection of a registered tool onto the plain SDK tool type. */
type SdkProjection<T> = T extends AgentTool<infer INPUT, infer OUTPUT> ? Tool<INPUT, OUTPUT> : T;

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
  repeat: RepeatPolicy;
  pollTimeoutMs?: number;
  model?: LanguageModel;
  kind: 'agent' | 'sdk';
  available?: AgentAvailability;
  candidates?: CandidateProvider;
  resolutionKey?: (context: AgentContext) => string;
  inspect?: (input: JsonValue, context: AgentContext) => InputInspection | PromiseLike<InputInspection>;
  resolveInput?: (context: AgentContext) => JsonValue | PromiseLike<JsonValue>;
  invoke: (input: JsonValue, options: AgentToolExecutionOptions) => JsonValue | PromiseLike<JsonValue>;
}

const reservedPrefixes = ['respond:', 'call:'] as const;

export function registerTools(tools: AgentToolSet): Map<string, RegisteredTool> {
  const registry = new Map<string, RegisteredTool>();

  for (const [name, tool] of Object.entries(tools)) {
    const reservedPrefix = reservedPrefixes.find((prefix) => name.startsWith(prefix));

    if (reservedPrefix !== undefined) {
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
  // SAFETY: registration checks each optional SDK field before it is used.
  const record = tool as ToolRecord;

  if (record['type'] === 'provider' || record['isProviderExecuted'] === true) {
    throw new ToolRegistrationError(
      `Tool "${name}" is provider-defined or provider-executed. This runtime executes local function tools only.`,
    );
  }

  if (record['type'] === 'dynamic') {
    throw new ToolRegistrationError(`Tool "${name}" is a dynamic tool. Dynamic tools are not supported in this phase.`);
  }

  if (record['inputSchema'] === undefined) {
    throw new ToolRegistrationError(`Tool "${name}" has no input schema.`);
  }

  if (record.execute === undefined) {
    throw new ToolRegistrationError(
      `Tool "${name}" has no execute function. This runtime cannot delegate execution to a client.`,
    );
  }

  const description = record.description ?? name;

  if (isAgentTool(tool)) {
    return {
      name,
      description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      risk: tool.risk,
      repeat: tool.repeat,
      pollTimeoutMs: tool.pollTimeoutMs,
      model: tool.model,
      kind: 'agent',
      available: tool.available,
      candidates: tool.candidates,
      resolutionKey: tool.resolutionKey,
      inspect: tool.inspect,
      resolveInput: tool.resolveInput,
      invoke: async (input, options) => {
        const output = await tool.execute(input, options);

        if (!isJsonValue(output)) throw new ToolRegistrationError(`Tool "${name}" returned a non-JSON value.`);

        return output;
      },
    };
  }

  // SAFETY: the function check above establishes the SDK execute callback contract used here.
  const sdkExecute = record.execute as (
    input: JsonValue,
    options: ToolExecutionOptions<JsonValue>,
  ) => JsonValue | PromiseLike<JsonValue>;

  return {
    name,
    description,
    // SAFETY: inputSchema was checked for presence above; the SDK validates its concrete schema later.
    inputSchema: record.inputSchema as FlexibleSchema<any>,
    // SAFETY: outputSchema is optional and is validated by the SDK when present.
    outputSchema: record.outputSchema as FlexibleSchema<any> | undefined,
    risk: 'unknown',
    repeat: 'allow',
    kind: 'sdk',
    invoke: async (input, options) => {
      const output = await sdkExecute(input, {
        toolCallId: options.toolCallId,
        messages: options.messages,
        abortSignal: options.abortSignal,
        context: undefined,
      });

      if (!isJsonValue(output)) throw new ToolRegistrationError(`Tool "${name}" returned a non-JSON value.`);

      return output;
    },
  };
}

interface ToolRecord {
  type?: string;
  isProviderExecuted?: boolean;
  description?: string;
  inputSchema?: FlexibleSchema<any>;
  outputSchema?: FlexibleSchema<any>;
  execute?: (...arguments_: any[]) => any;
}
