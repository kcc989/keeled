/**
 * Replays recorded τ³ runs to measure whether Jev can fill tool arguments from the fact
 * index. At every recorded tool call it rebuilds the index from what had been seen before
 * that call, asks Jev for each argument, and compares the answer with the model's actual
 * argument and, for writes, with the task's reference action. Raw confidences are saved so
 * thresholds can be compared without calling Jev again. It reads files by path and imports
 * nothing from the benchmark.
 *
 *   bun run examples/tau-bridge/src/replay-arguments.ts \
 *     --runs a/results.json --runs b/results.json --tasks tasks.json --tools specs.json \
 *     --policy policy.md --out replay.json [--mode records|values]
 */
import { parseArgs } from 'node:util';
import {
  annotateRecords,
  candidatesFor,
  emptyLedger,
  factIndex,
  ledgerFacts,
  presentResult,
  recordIndex,
  recordsWith,
  updateLedger,
  type CallRecord,
  type RequestLedger,
} from '@keeled/core';
import { openRouterModels, providersFromEnvironment } from './models.ts';
import { chooseArguments, type ArgumentPick, type RecordGroup } from '@keeled/jev';
import { TypeSafeClient, type JsonValue } from '@typesafe-ai/sdk';
import type { ToolSpec } from './tools.ts';

interface Message {
  role: 'assistant' | 'user' | 'tool';
  content?: string | null;
  tool_calls?: { id: string; name: string; arguments: Record<string, unknown> }[] | null;
  id?: string;
  error?: boolean;
}

interface Simulation {
  task_id: string;
  messages: Message[];
}

interface ReferenceAction {
  name: string;
  arguments: Record<string, unknown>;
}

interface Leaf {
  key: string;
  name: string;
  value: string | number;
}

export interface ReplayRecord {
  run: string;
  task: string;
  tool: string;
  write: boolean;
  key: string;
  modelValue: string | number;
  referenceValue?: string | number;
  candidates: number;
  /** Whether the reference value (or, without one, the model's) is a ledger slot value. */
  ledgerCovered?: boolean;
  /** Filled as part of a record group rather than singly. */
  grouped: boolean;
  modelCovered: boolean;
  referenceCovered?: boolean;
  pick: ArgumentPick;
  ms: number;
}

const { values: flags } = parseArgs({
  options: {
    runs: { type: 'string', multiple: true },
    tasks: { type: 'string' },
    tools: { type: 'string' },
    policy: { type: 'string' },
    out: { type: 'string' },
    concurrency: { type: 'string', default: '6' },
    // `values` asks each parameter singly; `records` fills parameters that belong together from
    // one record; `ledger` adds the request ledger's slots, record matches, and the ledger itself.
    mode: { type: 'string', default: 'records' },
    // Cache of ledgers per user message, reused across runs of the replay.
    ledgers: { type: 'string' },
    // Ask one request per parameter (or group) instead of one per call.
    isolate: { type: 'boolean', default: false },
    // `full` sends the policy, transcript, and recent calls; `slim` only the transcript and
    // the calls that produced the parameter's candidates.
    state: { type: 'string', default: 'full' },
    // Keep every Nth recorded call with arguments, so configurations compare on one subset.
    sample: { type: 'string', default: '1' },
  },
});
if (!flags.runs?.length || !flags.tasks || !flags.tools || !flags.out) {
  console.error('Usage: --runs <results.json...> --tasks <tasks.json> --tools <specs.json> [--policy policy.md] --out <file>');
  process.exit(1);
}

const tools = new Map<string, ToolSpec>(((await Bun.file(flags.tools).json()) as ToolSpec[]).map(spec => [spec.name, spec]));
const references = new Map<string, ReferenceAction[]>(
  ((await Bun.file(flags.tasks).json()) as { id: string; evaluation_criteria?: { actions?: ReferenceAction[] } }[]).map(task => [
    task.id,
    task.evaluation_criteria?.actions ?? [],
  ]),
);
const policy = flags.policy === undefined ? '' : await Bun.file(flags.policy).text();
const client = new TypeSafeClient();

// Every decision point is prepared first, then Jev is asked with bounded concurrency. In
// ledger mode, each conversation's ledger is first brought up to date at every user message.
const jobs: (() => Promise<ReplayRecord[]>)[] = [];
const conversations: { key: string; messages: Message[] }[] = [];
const ledgerCache = new Map<string, { ledger: RequestLedger; ms: number }>(
  flags.ledgers !== undefined && (await Bun.file(flags.ledgers).exists())
    ? Object.entries((await Bun.file(flags.ledgers).json()) as Record<string, { ledger: RequestLedger; ms: number }>)
    : [],
);
for (const path of flags.runs) {
  const run = path.split('/').at(-2) ?? path;
  const simulations = ((await Bun.file(path).json()) as { simulations: Simulation[] }).simulations;
  for (const simulation of simulations) {
    const conversation = `${run}|${simulation.task_id}|${simulations.indexOf(simulation)}`;
    conversations.push({ key: conversation, messages: simulation.messages });
    const history: CallRecord[] = [];
    const transcript: { role: string; text: string }[] = [];
    const pending = new Map<string, CallRecord>();
    let userMessages = 0;

    for (const message of simulation.messages) {
      if (message.role === 'tool') {
        const call = pending.get(message.id ?? '');
        if (call !== undefined) {
          history.push({ ...call, outcome: message.error ? 'error' : 'result', result: parse(message.content ?? '') });
          pending.delete(message.id ?? '');
        }
        continue;
      }
      if (message.role === 'assistant' && message.tool_calls?.length) {
        for (const toolCall of message.tool_calls) {
          const spec = tools.get(toolCall.name);
          const leaves = flatten(toolCall.arguments);
          if (spec !== undefined && leaves.length > 0) {
            jobs.push(
              decisionPoint(run, simulation.task_id, spec, toolCall.arguments, leaves, [...history], [...transcript], `${conversation}|${userMessages}`),
            );
          }
          pending.set(toolCall.id, { ref: toolCall.id, turn: 'current', tool: toolCall.name, input: toolCall.arguments, outcome: 'result', result: undefined });
        }
        continue;
      }
      if (message.content) {
        transcript.push({ role: message.role, text: message.content });
        if (message.role === 'user') userMessages += 1;
      }
    }
  }
}

if (flags.mode === 'ledger') await buildLedgers();

const every = Math.max(1, Number(flags.sample));
jobs.splice(0, jobs.length, ...jobs.filter((_, index) => index % every === 0));
console.log(`${jobs.length} recorded tool calls with arguments; asking Jev (${flags.isolate ? 'one request per parameter' : 'one request per call'}, ${flags.state} state)…`);
const records: ReplayRecord[] = [];
let done = 0;
await Promise.all(
  Array.from({ length: Number(flags.concurrency) }, async () => {
    while (jobs.length > 0) {
      const job = jobs.shift()!;
      try {
        records.push(...(await job()));
      } catch (error) {
        console.error(`skipped a decision point: ${error instanceof Error ? error.message : String(error)}`);
      }
      done += 1;
      if (done % 25 === 0) console.log(`  ${done} done`);
    }
  }),
);
await Bun.write(flags.out, JSON.stringify(records, null, 1));
console.log(`wrote ${records.length} argument judgements to ${flags.out}`);

async function buildLedgers(): Promise<void> {
  const modelId = process.env['KEELED_MODEL'];
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!modelId || !apiKey) throw new Error('Ledger mode needs KEELED_MODEL and OPENROUTER_API_KEY.');
  const { argumentsModel } = openRouterModels(modelId, apiKey, providersFromEnvironment());
  const queue = [...conversations];
  let updated = 0;
  console.log(`building request ledgers for ${queue.length} conversations…`);
  await Promise.all(
    Array.from({ length: Number(flags.concurrency) }, async () => {
      while (queue.length > 0) {
        const { key, messages } = queue.shift()!;
        let ledger = emptyLedger;
        const history: CallRecord[] = [];
        const transcript: { role: string; text: string }[] = [];
        const pending = new Map<string, CallRecord>();
        let userMessages = 0;
        let sinceUpdate = 0;
        for (const message of messages) {
          if (message.role === 'tool') {
            const call = pending.get(message.id ?? '');
            if (call !== undefined) history.push({ ...call, outcome: message.error ? 'error' : 'result', result: parse(message.content ?? '') });
            continue;
          }
          if (message.role === 'assistant' && message.tool_calls?.length) {
            for (const toolCall of message.tool_calls) {
              pending.set(toolCall.id, { ref: toolCall.id, turn: 'current', tool: toolCall.name, input: toolCall.arguments, outcome: 'result', result: undefined });
            }
            continue;
          }
          if (!message.content) continue;
          transcript.push({ role: message.role, text: message.content });
          if (message.role !== 'user') continue;
          userMessages += 1;
          const cacheKey = `${key}|${userMessages}`;
          const cached = ledgerCache.get(cacheKey);
          if (cached !== undefined) {
            ledger = cached.ledger;
            sinceUpdate = history.length;
            continue;
          }
          const started = performance.now();
          ledger = await updateLedger(argumentsModel, {
            previous: ledger,
            transcript: [...transcript],
            newCalls: history.slice(sinceUpdate),
            instructions: policy,
          });
          sinceUpdate = history.length;
          ledgerCache.set(cacheKey, { ledger, ms: Math.round(performance.now() - started) });
          updated += 1;
          if (updated % 25 === 0) {
            console.log(`  ${updated} ledger updates`);
            if (flags.ledgers !== undefined) await Bun.write(flags.ledgers, JSON.stringify(Object.fromEntries(ledgerCache)));
          }
        }
      }
    }),
  );
  if (flags.ledgers !== undefined) await Bun.write(flags.ledgers, JSON.stringify(Object.fromEntries(ledgerCache)));
  console.log(`request ledgers ready (${updated} new updates, ${ledgerCache.size} cached in total)`);
}

function decisionPoint(
  run: string,
  task: string,
  spec: ToolSpec,
  input: Record<string, unknown>,
  leaves: Leaf[],
  history: CallRecord[],
  transcript: { role: string; text: string }[],
  ledgerKey: string,
): () => Promise<ReplayRecord[]> {
  return async () => {
    const ledger = flags.mode === 'ledger' ? (ledgerCache.get(ledgerKey)?.ledger ?? emptyLedger) : undefined;
    const facts = [
      ...(ledger === undefined ? [] : ledgerFacts(ledger)),
      ...factIndex(
        history,
        transcript.filter(entry => entry.role === 'user').map(entry => ({ text: entry.text })),
      ),
    ];
    const write = spec.risk !== 'read';
    const reference = write ? bestReference(references.get(task) ?? [], spec.name, leaves) : undefined;

    // Parameters sharing a parent (the call itself, or one item such as `flights.0`) are
    // offered as whole records when an earlier record has every one of their fields.
    const groups: RecordGroup[] = [];
    if (flags.mode === 'records' || flags.mode === 'ledger') {
      const known = ledger === undefined ? recordIndex(history) : annotateRecords(recordIndex(history), ledger);
      const byParent = new Map<string, Leaf[]>();
      for (const leaf of leaves) {
        const parent = leaf.key.includes('.') ? leaf.key.slice(0, leaf.key.lastIndexOf('.')) : 'call';
        byParent.set(parent, [...(byParent.get(parent) ?? []), leaf]);
      }
      for (const [parent, members] of byParent) {
        if (members.length < 2) continue;
        const matching = recordsWith(members.map(leaf => leaf.name), known);
        if (matching.length > 0) {
          groups.push({ key: parent, fields: members.map(leaf => ({ key: leaf.key, name: leaf.name })), records: matching });
        }
      }
    }
    const inGroup = new Set(groups.flatMap(group => group.fields.map(field => field.key)));
    const parameters = leaves
      .filter(leaf => !inGroup.has(leaf.key))
      .map(leaf => ({
        key: leaf.key,
        name: leaf.name,
        description: parameterDescription(spec, leaf.name),
        candidates: candidatesFor(leaf.name, facts),
      }));
    const fullState = {
      ...(ledger === undefined ? {} : { request_ledger: ledger }),
      original_request: transcript.filter(entry => entry.role === 'user').at(-1)?.text ?? '',
      agent_instructions: policy,
      transcript: transcript.slice(-10),
      tool_calls: history.slice(-30).map(call => ({
        ref: call.ref,
        tool: call.tool,
        input: call.input,
        outcome: call.outcome,
        result: presentResult(call.result, call.ref, 4_000),
      })),
    } as unknown as { [key: string]: JsonValue };
    // Only the calls a parameter's candidates came from, without the policy.
    const slimState = (sources: Set<string>) =>
      ({
        original_request: fullState['original_request'],
        transcript: transcript.slice(-10),
        tool_calls: history
          .filter(call => sources.has(call.ref))
          .map(call => ({ ref: call.ref, tool: call.tool, input: call.input, result: presentResult(call.result, call.ref, 4_000) })),
      }) as unknown as { [key: string]: JsonValue };
    const stateFor = (parameterList: typeof parameters, groupList: RecordGroup[]) =>
      flags.state === 'slim'
        ? slimState(
            new Set([
              ...parameterList.flatMap(parameter => parameter.candidates.flatMap(fact => fact.sources)),
              ...groupList.flatMap(group => group.records.flatMap(record => record.sources)),
            ]),
          )
        : fullState;
    const ask = (parameterList: typeof parameters, groupList: RecordGroup[]) =>
      chooseArguments({
        client,
        state: stateFor(parameterList, groupList),
        tool: { name: spec.name, description: spec.description },
        parameters: parameterList,
        groups: groupList,
      });

    const started = performance.now();
    const picks = flags.isolate
      ? (
          await Promise.all([
            ...parameters.map(parameter => ask([parameter], [])),
            ...groups.map(group => ask([], [group])),
          ])
        ).flat()
      : await ask(parameters, groups);
    const ms = Math.round(performance.now() - started);

    return leaves.map(leaf => {
      const group = groups.find(entry => entry.fields.some(field => field.key === leaf.key));
      const parameter = parameters.find(entry => entry.key === leaf.key);
      const values = new Set(
        group !== undefined
          ? group.records.map(record => String(record.fields[leaf.name]))
          : parameter!.candidates.map(fact => String(fact.value)),
      );
      const referenceValue = reference === undefined ? undefined : flatten(reference.arguments).find(entry => entry.key === leaf.key)?.value;
      return {
        run,
        task,
        tool: spec.name,
        write,
        key: leaf.key,
        modelValue: leaf.value,
        ...(referenceValue === undefined ? {} : { referenceValue, referenceCovered: values.has(String(referenceValue)) }),
        candidates: group !== undefined ? group.records.length : parameter!.candidates.length,
        ...(ledger === undefined
          ? {}
          : { ledgerCovered: ledger.slots.some(slot => slot.value === String(referenceValue ?? leaf.value)) }),
        grouped: group !== undefined,
        modelCovered: values.has(String(leaf.value)),
        pick: picks.find(pick => pick.key === leaf.key)!,
        ms,
      };
    });
  };
}

/** The reference action of the same tool that agrees with the recorded call on the most fields. */
function bestReference(actions: ReferenceAction[], tool: string, leaves: Leaf[]): ReferenceAction | undefined {
  let best: ReferenceAction | undefined;
  let score = -1;
  for (const action of actions.filter(candidate => candidate.name === tool)) {
    const theirs = new Map(flatten(action.arguments).map(leaf => [leaf.key, String(leaf.value)]));
    const agreement = leaves.filter(leaf => theirs.get(leaf.key) === String(leaf.value)).length;
    if (agreement > score) {
      best = action;
      score = agreement;
    }
  }
  return best;
}

/** Scalar leaves of an argument object, keyed by path: `flights.0.date`. */
function flatten(value: unknown, path: string[] = []): Leaf[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => flatten(item, [...path, String(index)]));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => flatten(inner, [...path, key]));
  }
  if ((typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value))) {
    const name = [...path].reverse().find(segment => !/^\d+$/.test(segment)) ?? 'value';
    return [{ key: path.join('.'), name, value }];
  }
  return [];
}

function parameterDescription(spec: ToolSpec, name: string): string | undefined {
  const properties = (spec.parameters as { properties?: Record<string, { description?: string }> }).properties;
  return properties?.[name]?.description;
}

function parse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}
