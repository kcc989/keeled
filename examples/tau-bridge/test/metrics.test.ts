import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readResults, runMetrics, type TauResults } from '../src/metrics.ts';

// A synthetic appointment setting; no benchmark data.
const results: TauResults = {
  tasks: [
    {
      id: '2',
      evaluation_criteria: {
        actions: [
          { name: 'find_patient', requestor: 'assistant' },
          { name: 'list_slots', requestor: 'assistant' },
          { name: 'book_slot', requestor: 'assistant' },
          { name: 'toggle_reminder', requestor: 'user' },
        ],
      },
    },
    { id: '10', evaluation_criteria: { actions: [] } },
  ],
  simulations: [
    {
      task_id: '10',
      trial: 0,
      reward_info: { reward: 1, action_checks: [] },
      messages: [{ role: 'assistant' }],
    },
    {
      task_id: '2',
      trial: 0,
      reward_info: {
        reward: 0,
        action_checks: [
          { action: { name: 'find_patient' }, action_match: true, tool_type: 'read' },
          { action: { name: 'list_slots' }, action_match: false, tool_type: 'read' },
          { action: { name: 'book_slot' }, action_match: false, tool_type: 'write' },
        ],
      },
      messages: [
        { role: 'user' },
        {
          role: 'assistant',
          tool_calls: [{ name: 'find_patient', requestor: 'assistant' }],
          raw_data: {
            keeled: {
              decisions: [
                {
                  action: { type: 'tool', tool: 'find_patient' },
                  probabilities: { find_patient: 0.7, list_slots: 0.2, book_slot: 0.1 },
                },
              ],
              trace: [
                { kind: 'session', detail: { controller: 'jev', toolGuide: true } },
                { kind: 'blocker', detail: { kind: 'missing_evidence', tool: 'book_slot', reason: 'r' } },
              ],
            },
          },
        },
        { role: 'tool', requestor: 'assistant', error: false },
        {
          role: 'assistant',
          tool_calls: [{ name: 'get_invoice', requestor: 'assistant' }],
          raw_data: {
            keeled: {
              decisions: [
                { action: { type: 'tool', tool: 'get_invoice' }, probabilities: { get_invoice: 0.6, book_slot: 0.4 } },
              ],
              trace: [{ kind: 'blocker', detail: { kind: 'missing_evidence', tool: 'book_slot', reason: 'r' } }],
            },
          },
        },
        { role: 'tool', requestor: 'assistant', error: true },
        { role: 'user', tool_calls: [{ name: 'toggle_reminder', requestor: 'user' }] },
        { role: 'tool', requestor: 'user', error: true },
      ],
    },
  ],
};

describe('run metrics', () => {
  test('counts tool selection outcomes against the reference and the evaluator checks', () => {
    const metrics = runMetrics(results, 'results.json');

    expect(metrics.tasks.map((row) => row.task)).toEqual(['2', '10']);
    expect(metrics.tasks[0]).toEqual({
      task: '2',
      trial: 0,
      reward: 0,
      settings: { controller: 'jev', toolGuide: true },
      decisions: 2,
      toolCalls: 2,
      toolErrors: 1,
      unreferencedCalls: 1,
      referenceReads: 2,
      missedReads: 1,
      referenceWrites: 1,
      missedWrites: 1,
      neverCalled: [
        { tool: 'list_slots', offered: 1 },
        { tool: 'book_slot', offered: 2 },
      ],
      blockers: { missing_evidence: 2 },
    });

    expect(metrics.totals).toEqual({
      simulations: 2,
      successes: 1,
      toolCalls: 2,
      toolErrors: 1,
      unreferencedCalls: 1,
      missedReads: 1,
      referenceReads: 2,
      missedWrites: 1,
      referenceWrites: 1,
      neverCalledReferenceTools: 2,
      offeredButNotChosen: 3,
      blockers: { missing_evidence: 2 },
    });

    expect(metrics.settings).toEqual([{ controller: 'jev', toolGuide: true }, null]);
  });

  test('reads simulations saved as separate files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'keeled-metrics-'));
    await mkdir(join(directory, 'simulations'));
    await writeFile(join(directory, 'results.json'), JSON.stringify({ tasks: results.tasks, simulations: [] }));

    for (const [index, simulation] of (results.simulations ?? []).entries()) {
      await writeFile(join(directory, 'simulations', `${index}.json`), JSON.stringify(simulation));
    }

    const read = await readResults(join(directory, 'results.json'));
    expect(runMetrics(read, 'x').totals).toEqual(runMetrics(results, 'x').totals);
  });
});
