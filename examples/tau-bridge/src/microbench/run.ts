import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  createAgent,
  observedReadCandidates,
  reduceState,
  schemaReadCandidates,
  type AgentContext,
  type AgentMessage,
  type Blocker,
  type GenerationTrace,
  type JsonObject,
  type JsonValue,
} from '@keeled/core';
import { jevObservedArguments, type ObservedArgumentTrace } from '@keeled/jev';
import { scriptedController, stubModel, userMessage } from '@keeled/core/testing';
import { bridgeTools } from '../tools.ts';
import { openRouterModels, providersFromEnvironment } from '../models.ts';
import { cases } from './cases.ts';
import { grade } from './grade.ts';

const argv = Bun.argv.slice(2);

if (argv.includes('--help')) {
  console.log(
    'Usage: bun run microbench [--mode candidates|observed|resolver|all] [--case ID[,ID]] [--domain NAME[,NAME]] [--difficulty simple|intermediate|complex] [--trials 1..20] [--output PATH]\nCases: ' +
      cases.map((c) => c.id).join(', '),
  );
  process.exit(0);
}

const option = (name: string, fallback: string) => {
  const i = argv.indexOf(name);

  return i < 0 ? fallback : (argv[i + 1] ?? fallback);
};

const mode = option('--mode', 'candidates');

if (!['candidates', 'observed', 'resolver', 'all'].includes(mode))
  throw new Error('Mode must be candidates, observed, resolver, or all.');

const trials = Number(option('--trials', '1'));

if (!Number.isInteger(trials) || trials < 1 || trials > 20) throw new Error('Trials must be between 1 and 20.');

const matches = (name: string, value: string) =>
  option(name, 'all') === 'all' || option(name, 'all').split(',').includes(value);

const selected = cases.filter(
  (c) => matches('--case', c.id) && matches('--domain', c.domain) && matches('--difficulty', c.difficulty),
);

if (selected.length === 0) throw new Error('No matching cases.');

const resolverLive = mode === 'resolver' || mode === 'all';

const observedLive = mode === 'observed' || mode === 'all';

const modelId = process.env['KEELED_MODEL'];

const key = process.env['OPENROUTER_API_KEY'];

if (resolverLive && (!modelId || !key)) throw new Error('Resolver mode requires KEELED_MODEL and OPENROUTER_API_KEY.');

if (observedLive && !process.env['TYPESAFE_API_KEY']) throw new Error('Observed mode requires TYPESAFE_API_KEY.');

const model = resolverLive ? openRouterModels(modelId!, key!, providersFromEnvironment()).argumentsModel : stubModel();

interface MicrobenchRow {
  case: string;
  domain: string;
  difficulty: 'simple' | 'intermediate' | 'complex';
  problem: string;
  layer: string;
  trial: number;
  passed: boolean;
  ms: number;
  schemaValid: boolean;
  matched: number;
  expectedCount: number;
  inputs: JsonValue[];
  expected: JsonObject[];
  blockers: Blocker[];
  error?: string;
  traces: GenerationTrace[];
  judgments: ObservedArgumentTrace[];
}

const rows: MicrobenchRow[] = [];

const groups: Record<string, { passed: number; total: number }> = {};

let passed = 0,
  total = 0;

for (let trial = 1; trial <= trials; trial++)
  for (const item of selected) {
    const history: AgentMessage[] = [
      {
        id: 'source-message',
        role: 'assistant',
        parts: [
          { type: 'tool-discover', toolCallId: 'source', state: 'output-available', input: {}, output: item.evidence },
        ],
      },
      userMessage(item.request),
    ];

    for (const layer of mode === 'all' ? ['candidates', 'observed', 'resolver'] : [mode]) {
      const start = performance.now();
      const traces: GenerationTrace[] = [];
      const judgments: ObservedArgumentTrace[] = [];
      const inputs: JsonValue[] = [];
      let blockers: Blocker[] = [];
      let error: string | undefined;

      try {
        if (layer === 'candidates') {
          const provider = schemaReadCandidates(item.tool, [
            item.tool,
            { name: 'discover', risk: 'read', parameters: {} },
          ]);

          // SAFETY: the adjacent validation or framework contract establishes the asserted type.
          const context = {
            conversation: history,
            state: reduceState(history),
            abortSignal: new AbortController().signal,
          } as AgentContext;

          inputs.push(...((await provider?.(context)) ?? []).map((c) => c.input));
        } else if (layer === 'observed') {
          const catalog = [item.tool, { name: 'discover', risk: 'read' as const, parameters: {} }];

          // SAFETY: the adjacent validation or framework contract establishes the asserted type.
          const context = {
            request: item.request,
            conversation: history,
            state: reduceState(history),
            abortSignal: new AbortController().signal,
          } as AgentContext;

          const exact = (await schemaReadCandidates(item.tool, catalog)?.(context)) ?? [];

          if (exact.length > 0) inputs.push(...exact.map((candidate) => candidate.input));
          else {
            const judge = jevObservedArguments({ onJudgment: (trace) => judgments.push(trace) });
            const provider = observedReadCandidates(item.tool, catalog, judge);
            inputs.push(...((await provider?.(context)) ?? []).map((candidate) => candidate.input));
          }
        } else {
          const agent = createAgent({
            instructions:
              'Complete the user request using only the supplied tool contracts, conversation, and observed evidence. For a request covering a collection, inspect each applicable record. Do not fabricate missing values.',
            model,
            controller: scriptedController({
              decisions: [
                ...Array.from({ length: item.steps }, () => ({ type: 'tool' as const, tool: item.tool.name })),
                { type: 'respond', outcome: 'blocked' },
              ],
            }),
            tools: bridgeTools(
              [item.tool],
              async (call) => {
                inputs.push(call.arguments);

                return { inspected: call.arguments };
              },
              model,
            ),
            respond: async () => ({ text: 'Microbenchmark complete.' }),
            onGeneration: (trace) => traces.push(trace),
            policy: { maxSteps: item.steps + 1, generationTimeoutMs: 15000, turnTimeoutMs: 45000 },
          });

          const result = await agent.run({ messages: history });
          blockers = result.state.blockers;

          if (result.stopReason === 'error' || traces.some((t) => t.status === 'error'))
            error = 'Runtime or generation error';

          if (item.expected.length === 0 && !result.state.blockers.some((b) => b.kind === 'missing_evidence'))
            error ??= 'Expected an explicit missing-evidence refusal.';
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }

      const schema = z.fromJSONSchema(item.tool.parameters);
      const valid = inputs.every((input) => schema.safeParse(input).success);
      const expected = layer === 'resolver' ? item.expected : (item.candidateExpected ?? item.expected);
      const score = grade(inputs, expected, valid, error !== undefined);
      const complete = score.passed;

      const row = {
        case: item.id,
        domain: item.domain,
        difficulty: item.difficulty,
        problem: item.problem,
        layer,
        trial,
        passed: complete,
        ms: Math.round(performance.now() - start),
        schemaValid: valid,
        matched: score.matched,
        expectedCount: expected.length,
        inputs,
        expected,
        blockers,
        error,
        traces,
        judgments,
      };

      rows.push(row);
      total++;

      if (complete) passed++;

      for (const group of [`${layer}/domain/${item.domain}`, `${layer}/difficulty/${item.difficulty}`]) {
        const counts = (groups[group] ??= { passed: 0, total: 0 });
        counts.total++;

        if (complete) counts.passed++;
      }

      console.log(
        `${complete ? 'PASS' : 'FAIL'} ${layer} ${item.id}: ${row.ms}ms, ${row.matched}/${row.expectedCount} matched`,
      );
    }
  }

const output = resolve(option('--output', `reviews/microbench/${new Date().toISOString().replaceAll(':', '-')}.json`));

await mkdir(resolve(output, '..'), { recursive: true });

await writeFile(
  output,
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
      dirty: Bun.spawnSync(['git', 'status', '--porcelain']).stdout.toString().trim().length > 0,
      mode,
      providers: resolverLive ? providersFromEnvironment() : [],
      model: resolverLive ? modelId : null,
      observedModel: observedLive ? (process.env['TYPESAFE_DEFAULT_MODEL'] ?? 'jev-latest') : null,
      trials,
      passed,
      total,
      groups,
      rows,
    },
    null,
    2,
  ) + '\n',
);

for (const [group, counts] of Object.entries(groups)) console.log(`${group}: ${counts.passed}/${counts.total}`);

console.log(`${passed}/${total} passed. Saved ${output}`);

process.exitCode = passed === total ? 0 : 1;
