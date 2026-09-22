import { jsonSchema, type LanguageModel } from 'ai';
import {
  MissingInformation,
  resolveToolInput,
  decisionContext,
  agentTool,
  type AgentContext,
  type AgentToolSet,
  type JsonValue,
  isJsonValue,
  jsonObject,
  jsonString,
  type RepeatPolicy,
  type RespondAdapter,
  type Risk,
  type StopReason,
} from '@keeled/core';

type JsonSchema = Parameters<typeof jsonSchema>[0];

/** A tool whose implementation lives on the other side of the bridge. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** JSON schema of the result, used to tell the controller what the tool reveals. */
  returns?: JsonSchema;
  risk?: Risk;
  /** Declared by the tool's owner; the bridge never infers it. Defaults to `allow`. */
  repeat?: RepeatPolicy;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: JsonValue;
}

export type ToolCallHandler = (call: ToolCallRequest, signal: AbortSignal) => Promise<JsonValue>;

/**
 * Registers each remote tool as an agent tool. The controller still selects every call and
 * the runtime still resolves and validates its input; only execution is delegated.
 */
export function bridgeTools(
  specs: readonly ToolSpec[],
  call: ToolCallHandler,
  argumentsModel?: LanguageModel,
  writeArgumentsModel?: LanguageModel,
  inputMode: 'resolved' | 'joint' = 'resolved',
): AgentToolSet {
  const tools: AgentToolSet = {};

  for (const spec of specs) {
    const schema = jsonSchema(spec.parameters);

    const base = {
      description: describe(spec),
      inputSchema: schema,
      risk: spec.risk ?? 'unknown',
      repeat: spec.repeat ?? 'allow',
      execute: (input, options) => {
        if (!isJsonValue(input)) throw new MissingInformation('Tool input is not JSON-serializable.');

        return call({ id: options.toolCallId, name: spec.name, arguments: input }, options.abortSignal);
      },
    } satisfies Parameters<typeof agentTool>[0];

    if (inputMode === 'joint') tools[spec.name] = agentTool(base);
    else
      tools[spec.name] = agentTool({
        ...base,
        resolveInput: async (context: AgentContext) => {
          const model = spec.risk === 'read' ? argumentsModel : (writeArgumentsModel ?? argumentsModel);

          return resolveToolInput(spec, context, model);
        },
      });
  }

  return tools;
}

/** The description the controller selects on: what the tool does and what it returns. */
export function describe(spec: ToolSpec): string {
  const returns = spec.returns === undefined ? undefined : summarizeReturns(spec.returns);

  if (returns === undefined) return spec.description;
  const base = spec.description.trim();
  const separator = /[.!?]$/.test(base) ? ' ' : '. ';

  return `${base}${separator}Returns ${returns.replace(/\.$/, '')}.`;
}

type SchemaNode = {
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
  anyOf?: SchemaNode[];
  enum?: unknown[];
  type?: string;
  items?: SchemaNode;
  prefixItems?: SchemaNode[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  description?: string;
};

/**
 * A compact type summary of a result schema, such as `{ user_id: string, tasks: string[] }[]`.
 * Objects nested inside a field collapse to `object`, so every top-level field is named
 * before the summary is clipped.
 */
export function summarizeReturns(schema: JsonSchema, max = 400): string | undefined {
  // SAFETY: the adjacent validation or framework contract establishes the asserted type.
  const root = schema as SchemaNode;
  // Result models wrap the value in a single `returns` field.
  const node = root.properties?.['returns'] ?? root;
  const defs = root.$defs ?? {};
  let text = describeSchema(node, defs, 0);

  if (text === 'string' && node.description !== undefined) text = `a string: ${node.description}`;

  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function describeSchema(node: SchemaNode | undefined, defs: Record<string, SchemaNode>, depth: number): string {
  if (node === undefined) return 'unknown';

  if (node.$ref !== undefined) return describeSchema(defs[node.$ref.split('/').at(-1) ?? ''], defs, depth);

  if (node.anyOf !== undefined) {
    const options = node.anyOf
      .filter((option) => option.type !== 'null')
      .map((option) => describeSchema(option, defs, depth));

    return [...new Set(options)].join(' | ');
  }

  if (node.enum !== undefined) return node.enum.map((value) => JSON.stringify(value)).join(' | ');

  if (node.prefixItems !== undefined) {
    return `[${node.prefixItems.map((item) => describeSchema(item, defs, depth + 1)).join(', ')}]`;
  }

  if (node.type === 'array') return `${describeSchema(node.items, defs, depth)}[]`;

  if (node.properties !== undefined) {
    if (depth >= 1) return 'object';

    const fields = Object.entries(node.properties).map(
      ([key, value]) => `${key}: ${describeSchema(value, defs, depth + 1)}`,
    );

    return `{ ${fields.join(', ')} }`;
  }

  if (isSchemaNode(node.additionalProperties)) {
    return `Record<string, ${describeSchema(node.additionalProperties, defs, depth + 1)}>`;
  }

  return node.type ?? 'unknown';
}

function blockers(records: readonly { reason: string }[]): string {
  return records.length === 0 ? 'None.' : records.map((record) => `- ${record.reason}`).join('\n');
}

const guidance: Record<StopReason, string> = {
  completed: 'The work for this request is finished. Tell the user the outcome.',
  needs_input:
    'This turn stopped for input. Ask only for the specific missing user information or confirmation identified by the execution state. If an action was denied, explain the denial; confirmation alone does not resolve a policy denial.',
  blocked: 'The work cannot continue. Explain why to the user.',
  limit: 'The step budget ran out. Report what was done and what remains.',
  error: 'A runtime error stopped the work. Report what was done and what failed.',
  cancelled: 'The work was cancelled.',
};

/**
 * Writes the next message to the user with the whole conversation in view. It cannot call
 * tools itself, but it knows which ones the agent has, so it never denies a capability and
 * asks for exactly the inputs those tools need.
 */
export function respondWith(specs: readonly ToolSpec[], draftModel?: LanguageModel): RespondAdapter {
  const catalog = specs.map((spec) => `- ${spec.name}(${inputs(spec)}): ${describe(spec)}`).join('\n');

  return async (context) => {
    const generation = {
      purpose: 'response',
      model: draftModel,
      system: [
        'You write the final message of this agent turn. Execution has stopped. No tool will run after ' +
          'this reply. The reply cannot schedule work. Report background work only when a tool result shows ' +
          'it was already scheduled. Do not promise to perform an unexecuted action. ' +
          'The agent has these tools, but availability does not mean an action was permitted or executed:\n' +
          catalog,
        'Report only what the tool results below support and never claim an action that was not ' +
          'taken. Never tell the user the agent lacks a tool listed above. When information is missing, ' +
          'ask only for what these tools need and cannot look up themselves.',
        guidance[context.stopReason],
        await decisionContext(context, 'Support the response using exact observed facts and operation outcomes.'),
        `Blockers this turn:\n${blockers(context.state.blockers)}`,
      ].join('\n\n'),

      prompt: context.request,
      abortSignal: context.abortSignal,
    };

    const result = await context.generateText(generation);

    return { text: result.text };
  };
}

function inputs(spec: ToolSpec): string {
  const schema = isJsonValue(spec.parameters) ? jsonObject(spec.parameters) : undefined;
  const names = Object.keys(jsonObject(schema?.['properties']) ?? {});
  const requiredValue = schema?.['required'];

  const required = new Set(
    Array.isArray(requiredValue)
      ? requiredValue.flatMap((value) => {
          const name = jsonString(value);

          return name === undefined ? [] : [name];
        })
      : [],
  );

  return names.map((name) => (required.has(name) ? name : `${name}?`)).join(', ');
}

function isSchemaNode(value: SchemaNode | boolean | undefined): value is SchemaNode {
  return typeof value === 'object' && value !== null;
}
