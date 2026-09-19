import { jsonSchema, type LanguageModel } from 'ai';
import {
  MissingInformation,
  observedReadCandidates,
  schemaReadCandidates,
  agentTool,
  callHistory,
  presentResult,
  projectMessages,
  type AgentContext,
  type AgentMessage,
  type AgentToolSet,
  type Observation,
  type ObservedArgumentJudge,
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
  arguments: unknown;
}

export type ToolCallHandler = (call: ToolCallRequest, signal: AbortSignal) => Promise<unknown>;

/**
 * Registers each remote tool as an agent tool. The controller still selects every call and
 * the runtime still resolves and validates its input; only execution is delegated.
 */
export function bridgeTools(
  specs: readonly ToolSpec[],
  call: ToolCallHandler,
  argumentsModel?: LanguageModel,
  writeArgumentsModel?: LanguageModel,
  observedArgumentJudge?: ObservedArgumentJudge,
): AgentToolSet {
  const tools: AgentToolSet = {};
  for (const spec of specs) {
    const schema = jsonSchema(spec.parameters);
    tools[spec.name] = agentTool({
      description: describe(spec),
      inputSchema: schema,
      risk: spec.risk ?? 'unknown',
      repeat: spec.repeat ?? 'allow',
      candidates: readCandidates(spec, specs, observedArgumentJudge),
      resolveInput: async context => {
        const model = spec.risk === 'read' ? argumentsModel : (writeArgumentsModel ?? argumentsModel);
        return resolveInput(spec, context, model);
      },
      execute: (input, options) =>
        call({ id: options.toolCallId, name: spec.name, arguments: input }, options.abortSignal),
    });
  }
  return tools;
}

/** Exact projection is free and certain; semantic observed domains are its fallback. */
function readCandidates(
  spec: ToolSpec,
  specs: readonly ToolSpec[],
  judge: ObservedArgumentJudge | undefined,
) {
  const exact = schemaReadCandidates(spec, specs);
  const observed = judge === undefined ? undefined : observedReadCandidates(spec, specs, judge);
  if (exact === undefined) return observed;
  if (observed === undefined) return exact;
  return async (context: AgentContext) => {
    const projected = await exact(context);
    return projected.length > 0 ? projected : observed(context);
  };
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
  const root = schema as SchemaNode;
  // Result models wrap the value in a single `returns` field.
  const node = root.properties?.['returns'] ?? root;
  const defs = root.$defs ?? {};
  let text = shape(node, defs, 0);
  if (text === 'string' && node.description !== undefined) text = `a string: ${node.description}`;
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function shape(node: SchemaNode | undefined, defs: Record<string, SchemaNode>, depth: number): string {
  if (node === undefined) return 'unknown';
  if (node.$ref !== undefined) return shape(defs[node.$ref.split('/').at(-1) ?? ''], defs, depth);
  if (node.anyOf !== undefined) {
    const options = node.anyOf.filter(option => option.type !== 'null').map(option => shape(option, defs, depth));
    return [...new Set(options)].join(' | ');
  }
  if (node.enum !== undefined) return node.enum.map(value => JSON.stringify(value)).join(' | ');
  if (node.prefixItems !== undefined) {
    return `[${node.prefixItems.map(item => shape(item, defs, depth + 1)).join(', ')}]`;
  }
  if (node.type === 'array') return `${shape(node.items, defs, depth)}[]`;
  if (node.properties !== undefined) {
    if (depth >= 1) return 'object';
    const fields = Object.entries(node.properties).map(([key, value]) => `${key}: ${shape(value, defs, depth + 1)}`);
    return `{ ${fields.join(', ')} }`;
  }
  if (typeof node.additionalProperties === 'object') {
    return `Record<string, ${shape(node.additionalProperties, defs, depth + 1)}>`;
  }
  return node.type ?? 'unknown';
}

// Unlike the runtime's default resolver, this one reads the whole conversation, because
// identifiers the user gave in earlier turns are needed in later ones.
async function resolveInput(
  spec: ToolSpec,
  context: AgentContext,
  model: LanguageModel | undefined,
): Promise<unknown> {
  const properties = (spec.parameters as { properties?: Record<string, unknown> }).properties;
  if (properties === undefined || Object.keys(properties).length === 0) return {};

  const action = context.action;
  const earlier = callHistory(context.conversation, context.state.observations).filter(call => call.tool === spec.name);
  const { object } = await context.generateObject<Resolution>({
    model,
    schema: resolutionSchema(spec.parameters),
    name: spec.name, purpose: 'tool_input',
    description: spec.description,
    system:
      'You produce the input for a single tool call, or report that you cannot. Use only values stated in the ' +
      'conversation or returned by earlier tool calls; never invent values or substitute placeholders. ' +
      'Do not repeat an input this tool was already called with unless its result may have changed since. ' +
      'If the call cannot be made yet because information is missing, set status to "missing" and say what is ' +
      'needed and where it could come from.',
    prompt: [
      `Agent instructions:\n${context.instructions}`,
      `Conversation:\n${transcript(context)}`,
      `Tool calls so far:\n${callLog(context.conversation, context.state.observations)}`,
      `Blockers this turn:\n${blockers(context.state.blockers)}`,
      `Tool:\n${spec.name} — ${spec.description}`,
      earlier.length === 0
        ? `Earlier calls of ${spec.name}: none.`
        : `Earlier calls of ${spec.name}:\n` +
          earlier.map(call => `- [${call.ref}] input ${JSON.stringify(call.input)} ${call.outcome === 'result' ? 'returned a result' : 'failed'}`).join('\n'),
      ...(action?.awaitingInput === undefined
        ? []
        : [
            `This action is awaiting the user's confirmation with input ${JSON.stringify(action.awaitingInput)}. ` +
              'If the user confirmed it unchanged, return exactly this input.',
          ]),
      `Input JSON schema:\n${JSON.stringify(spec.parameters)}`,
    ].join('\n\n'),
  });

  if (object.status === 'missing') throw new MissingInformation(object.missing?.trim() || 'unspecified information');
  return object.arguments ?? {};
}

interface Resolution {
  status: 'ready' | 'missing';
  arguments?: unknown;
  missing?: string;
}

/**
 * The tool's input schema wrapped so the model can decline: `ready` with arguments, or
 * `missing` with what is needed. The tool's definitions move to the root, where its
 * references point.
 */
function resolutionSchema(parameters: JsonSchema) {
  const { $defs, ...input } = parameters as Record<string, unknown>;
  return jsonSchema<Resolution>({
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ready', 'missing'] },
      arguments: input,
      missing: { type: 'string', description: 'When status is "missing": what is needed and where it could come from.' },
    },
    required: ['status'],
    ...($defs === undefined ? {} : { $defs }),
  } as JsonSchema);
}

function transcript(context: AgentContext): string {
  return context.messages
    .map(message => `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`)
    .join('\n');
}

// Execution state resets at the end of each turn, but the tool parts persist in the
// conversation, so the log spans every turn. Each entry carries its reference; a result too
// large to show whole appears as a page of complete records with the rest retrievable.
function callLog(conversation: readonly AgentMessage[], observations: readonly Observation[], limit = 30): string {
  const calls = callHistory(conversation, observations).slice(-limit);
  if (calls.length === 0) return 'None.';
  return calls
    .map(call => {
      const when = call.turn === 'current' ? 'this turn' : 'earlier turn';
      const made = `${call.tool}(${JSON.stringify(call.input)})`;
      return call.outcome === 'result'
        ? `- [${call.ref}, ${when}] ${made} returned ${JSON.stringify(presentResult(call.result, call.ref))}`
        : `- [${call.ref}, ${when}] ${made} failed: ${String(call.result)}`;
    })
    .join('\n');
}

function blockers(records: readonly { reason: string }[]): string {
  return records.length === 0 ? 'None.' : records.map(record => `- ${record.reason}`).join('\n');
}

const guidance: Record<StopReason, string> = {
  completed: 'The work for this request is finished. Tell the user the outcome.',
  needs_input: 'Information is missing. Ask the user precisely for what you need.',
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
  const catalog = specs.map(spec => `- ${spec.name}(${inputs(spec)}): ${describe(spec)}`).join('\n');
  return async context => {
    const result = await context.generateText({
      purpose: 'response',
      ...(draftModel !== undefined ? { model: draftModel } : {}),
      system: [
        context.instructions,
        'You write the next message to the user. You cannot call tools in this message, but the agent ' +
          'can call these tools on later turns:\n' + catalog,
        'Report only what the tool results below support and never claim an action that was not ' +
          'taken. Never tell the user the agent lacks a tool listed above. When information is missing, ' +
          'ask only for what these tools need and cannot look up themselves.',
        guidance[context.stopReason],
        `Tool calls so far:\n${callLog(context.conversation, context.state.observations)}`,
        `Blockers this turn:\n${blockers(context.state.blockers)}`,
        `Retained goals and constraints:\n${JSON.stringify(context.state.task)}`,
        `Application-verified facts and effects (do not replace with mental arithmetic):\n${JSON.stringify(context.state.inspections)}`,
      ].join('\n\n'),
      messages: projectMessages(context.conversation),
      abortSignal: context.abortSignal,
    });
    return { text: result.text };
  };
}

function inputs(spec: ToolSpec): string {
  const schema = spec.parameters as { properties?: Record<string, unknown>; required?: string[] };
  const names = Object.keys(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  return names.map(name => (required.has(name) ? name : `${name}?`)).join(', ');
}
