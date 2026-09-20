import { asSchema } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { callHistory, projectMessages } from './projection.ts';
import { createId, stableHash } from './ids.ts';
import { jsonObject, type JsonValue } from './json.ts';
import { validateInput } from './validation.ts';
import type { Controller, ControllerContext, ControlResult } from './controller.ts';
import type { ManagedGeneration, UsageBucket } from './types.ts';
import type { RegisteredTool } from './tool.ts';

export interface DiscoveryOptions {
  enabled: boolean;
  /** Maximum prepared reads across all discovery procedures in one turn. Default 8. */
  maxCalls?: number;
}

export interface DiscoveryQuestion {
  objective: string;
  constraints: string[];
  record: JsonValue;
}

export interface DiscoveryEvaluation {
  verdict: 'match' | 'no_match' | 'uncertain';
  model?: string;
  probabilities?: Record<string, number>;
  usage?: UsageBucket;
}

export interface DiscoveryRecord {
  id: string;
  source: string;
  path: string[];
  tool: string;
  objective: string;
  mode: 'any' | 'unique' | 'all';
  total: number;
  inspected: number;
  matches: string[];
  uncertain: string[];
  status: 'running' | 'finished' | 'incomplete';
  reason: string;
}

const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

const planSchema = z.object({
  use: z.boolean(),
  source: z.string(),
  tool: z.string(),
  inputField: z.string().describe('The single required input property declared by the selected tool.'),
  valuePath: z
    .array(z.string())
    .describe(
      'Own-property path INSIDE EACH collection item to its scalar reference. Empty for scalar items; never the path to the collection.',
    ),
  objective: z.string(),
  constraints: z.array(z.string()),
  mode: z.enum(['any', 'unique', 'all']),
});

type Plan = z.infer<typeof planSchema>;

interface Collection {
  id: string;
  ref: string;
  tool: string;
  path: string[];
  values: JsonValue[];
}

interface Active {
  plan: Plan;
  source: Collection;
  inputs: JsonValue[];
  cursor: number;
  record: DiscoveryRecord;
  pending?: { input: JsonValue; previousRefs: Set<string> };
}

/** Own-property paths only. Model proposals cannot access prototypes or executable expressions. */
export function discoveryValue(value: JsonValue, path: readonly string[]): JsonValue {
  for (const key of path) {
    const container = Array.isArray(value) ? value : jsonObject(value);

    if (container === undefined || !Object.hasOwn(container, key)) return undefined;
    value = Array.isArray(container) ? container[Number(key)] : container[key];
  }

  return value;
}

/** Only complete, bounded collections are offered; omission never means exhaustive coverage. */
function collections(context: ControllerContext): Collection[] {
  const found = new Map<string, Collection>();

  const latest = new Map(
    callHistory(context.conversation, context.observations).map((call) => [stableHash([call.tool, call.input]), call]),
  );

  let nodes = 0;

  for (const call of latest.values()) {
    if (call.outcome !== 'result') continue;

    const walk = (value: JsonValue, path: string[]) => {
      if (++nodes > 10_000 || path.length > 6) return;

      if (Array.isArray(value)) {
        if (value.length > 0 && value.length <= 64) {
          const id = stableHash([call.tool, call.input, path, value]);
          found.set(id, { id, ref: call.ref, tool: call.tool, path, values: value });
        }

        return;
      }

      const object = jsonObject(value);

      if (object !== undefined) for (const [key, child] of Object.entries(object)) walk(child, [...path, key]);
    };

    walk(call.result, []);
  }

  return [...found.values()];
}

/** Turn-local continuation. It returns ordinary prepared calls, never executes tools. */
export class DiscoveryRun {
  readonly #attempted = new Set<string>();
  #active: Active | undefined;
  #calls = 0;
  #plans = 0;

  constructor(
    readonly options: DiscoveryOptions,
    readonly registry: Map<string, RegisteredTool>,
    readonly controller: Controller,
    readonly generate: ManagedGeneration['generateObject'],
    readonly record: (record: DiscoveryRecord) => void,
    readonly account: (usage: UsageBucket) => void,
    readonly trace: (detail: string) => void,
  ) {}

  async next(context: ControllerContext): Promise<ControlResult | undefined> {
    const max = this.options.maxCalls ?? 8;

    if (this.#active === undefined) {
      if (this.#calls >= max || this.#plans >= max || context.budget.remaining < 1) return;
      const sources = collections(context).filter((source) => !this.#attempted.has(source.id));

      if (sources.length === 0) return;
      const tools = context.availableTools.filter((tool) => tool.risk === 'read' && tool.required.length === 1);

      if (tools.length === 0) return;

      for (const source of sources) this.#attempted.add(source.id);
      this.#plans++;

      const contracts = await Promise.all(
        tools.map(async (tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: await asSchema(tool.inputSchema).jsonSchema,
        })),
      );

      const { object: plan } = await this.generate<Plan>({
        schema: planSchema.extend({
          source: z
            .enum(['', ...sources.map((source) => source.id)])
            .describe(
              'The id of ONE offered sources entry. Never a tool name, result reference, or field name. Empty only when use=false.',
            ),
          tool: z
            .enum(['', ...tools.map((tool) => tool.name)])
            .describe('The read tool that accepts references from the selected collection. Empty only when use=false.'),
        }),
        name: 'discovery_plan',
        purpose: 'discovery_plan',
        system:
          'Propose one bounded read-only discovery procedure, or set use=false. Set source to the exact id of one entry in sources, not its ref, tool, or path. Establish from tool descriptions and evidence that a collection contains references accepted by a lookup tool. Matching JSON types alone is not evidence of this relationship. Use only a tool with one required input; inputField is that field. valuePath selects the reference inside each collection item; use [] for scalar items. Do not invent values. Inspect records only when needed for a pending request and not already inspected. The objective must be a direct semantic question about each returned record. Preserve all relevant user constraints. Do not use semantic matching for arithmetic, exact ordering, date comparisons, or best/cheapest selection: set use=false for those procedures. mode=any only when any acceptable item suffices, unique when identifying one item, all when every candidate must be inspected. No match in this collection does not mean no match exists elsewhere. For use=false return empty strings/arrays and mode=all.',
        prompt: JSON.stringify({
          instructions: context.instructions,
          request: context.request,
          task: context.state.task,
          conversation: projectMessages(context.conversation),
          sources,
          tools: contracts,
          priorCalls: callHistory(context.conversation, context.observations),
          previousDiscovery: context.state.discovery,
        }),
        abortSignal: context.abortSignal,
      });

      this.trace(`Proposed discovery: ${JSON.stringify(plan)}`);

      if (!plan.use) {
        this.trace('Planner declined discovery.');

        return;
      }

      const source = sources.find((entry) => entry.id === plan.source);
      const available = tools.find((entry) => entry.name === plan.tool);
      const tool = this.registry.get(plan.tool);

      if (
        source === undefined ||
        available === undefined ||
        tool === undefined ||
        available.required[0] !== plan.inputField
      ) {
        this.trace('Rejected discovery: invalid source, tool, or required input field.');

        return;
      }

      const inputs: JsonValue[] = [];

      for (const item of source.values) {
        const value = discoveryValue(item, plan.valuePath);

        if (!scalarSchema.safeParse(value).success) {
          this.trace('Rejected discovery: binding must resolve to an observed scalar.');

          return;
        }

        const input = { [plan.inputField]: value };
        const validated = await validateInput(tool, input);

        if (!validated.success || stableHash(validated.value) !== stableHash(input)) {
          this.trace('Rejected discovery: input invalid or schema transforms binding.');

          return;
        }

        if (!inputs.some((prior) => stableHash(prior) === stableHash(input))) inputs.push(input);
      }

      // Existing reads remain ordinary evidence. Do not repeat or silently count them as newly inspected.
      const history = callHistory(context.conversation, context.observations);

      if (
        inputs.some((input) =>
          history.some((call) => call.tool === plan.tool && stableHash(call.input) === stableHash(input)),
        )
      ) {
        this.trace('Declined discovery: candidate already attempted; return to ordinary reasoning.');

        return;
      }

      this.#active = {
        plan,
        source,
        inputs,
        cursor: 0,
        record: {
          id: createId('discovery'),
          source: source.ref,
          path: source.path,
          tool: plan.tool,
          objective: plan.objective,
          mode: plan.mode,
          total: inputs.length,
          inspected: 0,
          matches: [],
          uncertain: [],
          status: 'running',
          reason: 'Binding is an LLM inference; execution and matching are pending.',
        },
      };
      this.record(this.#active.record);
    }

    const active = this.#active;

    if (this.#calls >= max) {
      this.#finish('incomplete', 'Discovery call budget exhausted.');

      return;
    }

    const source = collections(context).find(
      (entry) => entry.id === active.source.id && entry.ref === active.source.ref,
    );

    if (
      source === undefined ||
      !context.availableTools.some((tool) => tool.name === active.plan.tool && tool.risk === 'read')
    ) {
      this.#finish('incomplete', 'Source or tool is no longer available.');

      return;
    }

    const input = active.inputs[active.cursor]!;
    active.pending = {
      input,
      previousRefs: new Set(callHistory(context.conversation, context.observations).map((call) => call.ref)),
    };
    this.#calls++;

    return {
      action: { type: 'tool_call', tool: active.plan.tool, input },
      rationale: `Discovery ${active.record.id}: inspect candidate ${active.cursor + 1}/${active.inputs.length}.`,
    };
  }

  async observe(context: ControllerContext): Promise<void> {
    const active = this.#active;

    if (active?.pending === undefined) return;
    const pending = active.pending;
    delete active.pending;

    const call = callHistory(context.conversation, context.observations).findLast(
      (entry) =>
        !pending.previousRefs.has(entry.ref) &&
        entry.tool === active.plan.tool &&
        stableHash(entry.input) === stableHash(pending.input),
    );

    if (call === undefined || call.outcome !== 'result') {
      this.#finish('incomplete', 'Read did not return a successful result; consult execution evidence.');

      return;
    }

    const answer = await this.controller.evaluateDiscovery!(
      {
        objective: active.plan.objective,
        constraints: active.plan.constraints,
        record: call.result,
      },
      context.abortSignal,
    );

    if (answer.usage !== undefined) this.account(answer.usage);
    active.cursor++;
    active.record.inspected++;

    if (answer.verdict === 'match') active.record.matches.push(call.ref);

    if (answer.verdict === 'uncertain') active.record.uncertain.push(call.ref);

    if (answer.verdict === 'uncertain') {
      this.#finish('incomplete', 'Record matching is uncertain; return to reasoning.');

      return;
    }

    if ((active.plan.mode === 'any' && answer.verdict === 'match') || active.cursor === active.inputs.length) {
      this.#finish(
        'finished',
        active.record.matches.length > 1 && active.plan.mode === 'unique'
          ? 'Multiple plausible matches. Identity remains ambiguous.'
          : 'Procedure finished. Matches are semantic judgments, not task completion or permission. Coverage is limited to this collection.',
      );

      return;
    }

    this.record(active.record);
  }

  stop(reason: string): void {
    this.#finish('incomplete', reason);
  }

  #finish(status: DiscoveryRecord['status'], reason: string): void {
    if (this.#active === undefined) return;
    this.#active.record.status = status;
    this.#active.record.reason = reason;
    this.record(this.#active.record);
    this.#active = undefined;
  }
}
