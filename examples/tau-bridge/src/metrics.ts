/**
 * Tool-selection metrics from saved τ³-bench results.
 *
 *   bun run tau3:metrics <results.json> [more results...]
 *
 * It reads only what a run records: the trajectory, the evaluator's action checks, and the
 * Keeled decisions and trace in each assistant message. It never changes a result.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { JsonValue } from '@keeled/core';

/** The recorded fields this script reads. Every other field is ignored. */
export interface TauResults {
  tasks?: TauTask[];
  simulations?: TauSimulation[];
}

interface TauTask {
  id: string;
  evaluation_criteria?: { actions?: TauAction[] | null } | null;
}

interface TauAction {
  name: string;
  requestor?: string;
}

interface TauSimulation {
  task_id: string;
  trial?: number | null;
  reward_info?: {
    reward?: number | null;
    action_checks?: { action: TauAction; action_match: boolean; tool_type?: string | null }[] | null;
  } | null;
  messages?: TauMessage[] | null;
}

interface TauMessage {
  role: string;
  tool_calls?: { name: string; requestor?: string }[] | null;
  requestor?: string;
  error?: boolean;
  raw_data?: { keeled?: KeeledLog } | null;
}

interface KeeledLog {
  decisions?: { action: { type: string; tool?: string }; probabilities?: { [label: string]: number } }[];
  trace?: { kind: string; detail?: { [key: string]: JsonValue } }[];
}

export interface TaskMetrics {
  task: string;
  trial: number | null;
  reward: number | null;
  /** The settings the bridge recorded for this conversation, or null for older runs. */
  settings: JsonValue;
  decisions: number;
  toolCalls: number;
  /** Agent calls whose result was an error. */
  toolErrors: number;
  /** Agent calls to a tool that no reference action uses: a proxy for a wrong tool. */
  unreferencedCalls: number;
  referenceReads: number;
  missedReads: number;
  referenceWrites: number;
  missedWrites: number;
  /** Reference tools the agent never called, and how many decisions offered each one. */
  neverCalled: { tool: string; offered: number }[];
  /** Declined attempts by blocker kind; empty for runs recorded before blockers were traced. */
  blockers: { [kind: string]: number };
}

export interface RunMetrics {
  source: string;
  settings: JsonValue[];
  tasks: TaskMetrics[];
  totals: {
    simulations: number;
    successes: number;
    toolCalls: number;
    toolErrors: number;
    unreferencedCalls: number;
    missedReads: number;
    referenceReads: number;
    missedWrites: number;
    referenceWrites: number;
    neverCalledReferenceTools: number;
    /** Decisions that offered a reference tool the agent never called. */
    offeredButNotChosen: number;
    blockers: { [kind: string]: number };
  };
  limits: string;
}

const limits =
  'Unreferenced calls are a proxy for wrong-tool selection: a reference trajectory is one valid ' +
  'path, not the only one. Missed reads and writes use the evaluator action checks. Offered counts ' +
  'use the options each decision recorded. Blocker counts need traces from a bridge that records blockers.';

export function taskMetrics(simulation: TauSimulation, task: TauTask | undefined): TaskMetrics {
  const messages = simulation.messages ?? [];
  const logs = messages.flatMap((message) => (message.raw_data?.keeled === undefined ? [] : [message.raw_data.keeled]));
  const decisions = logs.flatMap((log) => log.decisions ?? []);
  const trace = logs.flatMap((log) => log.trace ?? []);

  const calls = messages.flatMap((message) =>
    message.role === 'assistant' ? (message.tool_calls ?? []).filter((call) => call.requestor !== 'user') : [],
  );

  const reference = (task?.evaluation_criteria?.actions ?? []).filter((action) => action.requestor !== 'user');
  const referenceTools = new Set(reference.map((action) => action.name));
  const called = new Set(calls.map((call) => call.name));
  const checks = simulation.reward_info?.action_checks ?? [];
  const reads = checks.filter((check) => check.tool_type === 'read');
  const writes = checks.filter((check) => check.tool_type === 'write');
  const blockers: { [kind: string]: number } = {};

  for (const entry of trace) {
    if (entry.kind !== 'blocker') continue;
    const kind = String(entry.detail?.['kind'] ?? 'unknown');
    blockers[kind] = (blockers[kind] ?? 0) + 1;
  }

  const neverCalled = [...referenceTools].flatMap((tool) =>
    called.has(tool)
      ? []
      : [{ tool, offered: decisions.filter((decision) => decision.probabilities?.[tool] !== undefined).length }],
  );

  return {
    task: String(simulation.task_id),
    trial: simulation.trial ?? null,
    reward: simulation.reward_info?.reward ?? null,
    settings: trace.find((entry) => entry.kind === 'session')?.detail ?? null,
    decisions: decisions.length,
    toolCalls: calls.length,
    toolErrors: messages.filter((message) => message.role === 'tool' && message.requestor !== 'user' && message.error)
      .length,
    unreferencedCalls: calls.filter((call) => !referenceTools.has(call.name)).length,
    referenceReads: reads.length,
    missedReads: reads.filter((check) => !check.action_match).length,
    referenceWrites: writes.length,
    missedWrites: writes.filter((check) => !check.action_match).length,
    neverCalled,
    blockers,
  };
}

export function runMetrics(results: TauResults, source: string): RunMetrics {
  const tasks = new Map((results.tasks ?? []).map((task) => [String(task.id), task]));

  const rows = (results.simulations ?? [])
    .map((simulation) => taskMetrics(simulation, tasks.get(String(simulation.task_id))))
    .sort(
      (left, right) =>
        left.task.localeCompare(right.task, undefined, { numeric: true }) || (left.trial ?? 0) - (right.trial ?? 0),
    );

  const sum = (pick: (row: TaskMetrics) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const blockers: { [kind: string]: number } = {};

  for (const row of rows) {
    for (const [kind, count] of Object.entries(row.blockers)) blockers[kind] = (blockers[kind] ?? 0) + count;
  }

  const settings = [...new Set(rows.map((row) => JSON.stringify(row.settings)))].map((text): JsonValue =>
    JSON.parse(text),
  );

  return {
    source,
    settings,
    tasks: rows,
    totals: {
      simulations: rows.length,
      successes: rows.filter((row) => row.reward === 1).length,
      toolCalls: sum((row) => row.toolCalls),
      toolErrors: sum((row) => row.toolErrors),
      unreferencedCalls: sum((row) => row.unreferencedCalls),
      missedReads: sum((row) => row.missedReads),
      referenceReads: sum((row) => row.referenceReads),
      missedWrites: sum((row) => row.missedWrites),
      referenceWrites: sum((row) => row.referenceWrites),
      neverCalledReferenceTools: sum((row) => row.neverCalled.length),
      offeredButNotChosen: sum((row) => row.neverCalled.reduce((total, entry) => total + entry.offered, 0)),
      blockers,
    },
    limits,
  };
}

/** Reads a results file, including the directory format that keeps simulations in separate files. */
export async function readResults(path: string): Promise<TauResults> {
  // SAFETY: τ³-bench writes this file from its Results model; only the fields above are read.
  const results = JSON.parse(await readFile(path, 'utf8')) as TauResults;

  if ((results.simulations ?? []).length > 0) return results;
  const directory = join(dirname(path), 'simulations');
  const names = await readdir(directory).catch(() => []);

  const files = names.filter((name) => name.endsWith('.json')).sort();

  const simulations = await Promise.all(
    files.map(async (name) => {
      // SAFETY: each file holds one serialized SimulationRun from the same run.
      const simulation = JSON.parse(await readFile(join(directory, name), 'utf8')) as TauSimulation;

      return simulation;
    }),
  );

  return { ...results, simulations };
}

if (import.meta.main) {
  const paths = Bun.argv.slice(2);

  if (paths.length === 0) {
    console.error('Usage: bun run tau3:metrics <results.json> [more results...]');
    process.exit(1);
  }

  const summaries = await Promise.all(paths.map(async (path) => runMetrics(await readResults(path), path)));
  console.log(JSON.stringify(summaries, null, 2));
}
