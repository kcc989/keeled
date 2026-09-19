import { expect, test } from 'bun:test';
import { z } from 'zod';
import { createTestAgent as createAgent } from './fixtures.ts';
import { agentTool } from '../src/tool.ts';
import { stubModel, userMessage } from '../src/testing.ts';
import type { Controller } from '../src/controller.ts';

test('a ready call uses stored input, survives controller mutation, and skips resolution', async () => {
  const inputs: unknown[] = [];
  let resolutions = 0;
  let decisions = 0;
  const agent = createAgent({
    instructions: 'Inspect the reservation.', model: stubModel({ text: 'Done.' }),
    controller: {
      name: 'candidate-test',
      async control(context) {
        if (decisions++ > 0) return { action: { type: 'respond', outcome: 'completed' } };
        const candidates = context.availableTools[0]!.candidates!;
        expect(candidates).toHaveLength(1); // Invalid and duplicate inputs were removed.
        const candidate = candidates[0]!;
        (candidate.input as { id: string }).id = 'tampered';
        return { action: { type: 'tool', tool: 'lookup', candidateId: candidate.id } };
      },
    },
    tools: { lookup: agentTool({
      description: 'Lookup', risk: 'read', inputSchema: z.object({ id: z.string() }),
      candidates: () => [
        { input: { id: 'R1' }, description: 'Reservation 1', sources: ['c1'] },
        { input: { id: 'R1' }, description: 'Duplicate', sources: ['c1'] },
        { input: { id: 123 as unknown as string }, description: 'Invalid', sources: ['c1'] },
      ],
      resolveInput: () => { resolutions++; return { id: 'fallback' }; },
      execute: input => { inputs.push(input); return { ok: true }; },
    }) },
  });
  const result = await agent.run({ messages: [userMessage('Inspect it.')] });
  expect(result.stopReason).toBe('completed');
  expect(inputs).toEqual([{ id: 'R1' }]);
  expect(resolutions).toBe(0);
});

test('stale candidate IDs are rejected without executing or falling back', async () => {
  let id = '';
  let decisions = 0;
  let executions = 0;
  const controller: Controller = {
    name: 'stale-test',
    async control(context) {
      if (decisions++ === 0) {
        id = context.availableTools[0]!.candidates![0]!.id;
        return { action: { type: 'tool', tool: 'lookup', candidateId: id } };
      }
      if (decisions === 2) return { action: { type: 'tool', tool: 'lookup', candidateId: id } };
      return { action: { type: 'respond', outcome: 'blocked' } };
    },
  };
  const result = await createAgent({
    instructions: 'Inspect.', controller, model: stubModel({ text: 'Stopped.' }),
    tools: { lookup: agentTool({
      description: 'Lookup', risk: 'read', inputSchema: z.object({ id: z.string() }),
      candidates: () => [{ input: { id: 'R1' }, description: 'Inspect', sources: ['c1'] }],
      resolveInput: () => { throw new Error('Must not resolve'); },
      execute: () => { executions++; return {}; },
    }) },
  }).run({ messages: [userMessage('Inspect.')] });
  expect(executions).toBe(1);
  expect(result.state.blockers.some(b => b.kind === 'invalid_input')).toBe(true);
});

test('write tools cannot offer read candidates; ordinary resolution still works', async () => {
  let offered = false;
  let resolutions = 0;
  let decisions = 0;
  await createAgent({
    instructions: 'Write.', model: stubModel({ text: 'Done.' }),
    controller: { name: 'test', async control(context) {
      expect(context.availableTools[0]!.candidates).toBeUndefined();
      return { action: decisions++ === 0 ? { type: 'tool', tool: 'write' } : { type: 'respond', outcome: 'completed' } };
    } },
    tools: { write: agentTool({
      description: 'Write', risk: 'write', inputSchema: z.object({}),
      candidates: () => { offered = true; return []; },
      resolveInput: () => { resolutions++; return {}; }, execute: () => ({}),
    }) },
  }).run({ messages: [userMessage('Write.')] });
  expect(offered).toBe(false);
  expect(resolutions).toBe(1);
});

test('prepared read inputs still pass through application risk policy', async () => {
  let executions = 0;
  let decisions = 0;
  const result = await createAgent({
    instructions: 'Inspect.', model: stubModel({ text: 'Denied.' }), policy: { allowedRisks: ['write'] },
    controller: { name: 'test', async control(context) {
      if (decisions++ > 0) return { action: { type: 'respond', outcome: 'blocked' } };
      return { action: { type: 'tool', tool: 'lookup', candidateId: context.availableTools[0]!.candidates![0]!.id } };
    } },
    tools: { lookup: agentTool({
      description: 'Lookup', risk: 'read', inputSchema: z.object({}),
      candidates: () => [{ input: {}, description: 'Inspect', sources: ['c1'] }],
      execute: () => { executions++; return {}; },
    }) },
  }).run({ messages: [userMessage('Inspect.')] });
  expect(executions).toBe(0);
  expect(result.state.blockers.some(b => b.kind === 'policy_denied')).toBe(true);
});
