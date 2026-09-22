import { z } from 'zod';
import { createAgent } from '../src/agent.ts';
import { agentTool } from '../src/tool.ts';
import { expect, test } from 'bun:test';
import { GenerationHost } from '../src/generation.ts';
import { modelTaskTracker } from '../src/task-tracker.ts';
import { scriptedController, userMessage, stubModel, testFixture } from '../src/testing.ts';
import type { GenerationTrace } from '../src/types.ts';
import type { AgentContext } from '../src/tool.ts';

test('generation traces identify purpose and include failed calls', async () => {
  const traces: GenerationTrace[] = [];

  const host = new GenerationHost({
    defaultModel: stubModel({ text: 'Ready.' }),
    abortSignal: new AbortController().signal,
    usage: {
      model: { calls: 0, inputTokens: 0, outputTokens: 0 },
      controller: { calls: 0, inputTokens: 0, outputTokens: 0 },
    },
    onGeneration: (trace) => traces.push(trace),
  });

  await host.generateText({ purpose: 'response', prompt: 'Answer.' });
  const abort = new AbortController();
  abort.abort(new Error('Test cancellation'));
  await expect(
    host.generateText({ purpose: 'task_extract', prompt: 'Extract.', abortSignal: abort.signal }),
  ).rejects.toThrow();
  expect(traces).toMatchObject([
    { purpose: 'response', status: 'success', structured: false },
    { purpose: 'task_extract', status: 'error' },
  ]);
  expect(traces[1]?.error).toBeTruthy();
});

test('task extraction uses the cheap model while verification retains the default', async () => {
  const cheap = stubModel();
  const calls: Parameters<AgentContext['generateObject']>[0][] = [];

  // SAFETY: the test fixture intentionally models this exact compile-time shape.
  const context = testFixture<AgentContext>({
    state: { task: {}, observations: [], catalog: [] },
    conversation: [],
    messages: [],
    request: 'Update my document.',
    generateObject: async (options: Parameters<AgentContext['generateObject']>[0]) => {
      calls.push(options);

      return { object: { goals: [], constraints: [], withdrawals: [], checks: [] } };
    },
  });

  const tracker = modelTaskTracker({ extractionModel: cheap });
  await tracker.update(context);
  await tracker.verify(context);
  expect(calls[0]).toMatchObject({ purpose: 'task_extract', model: cheap, maxOutputTokens: 2048 });
  expect(calls[1]?.purpose).toBe('completion_verify');
  expect(calls[1]?.model).toBeUndefined();
  await modelTaskTracker({ extractionModel: cheap, verificationModel: cheap }).verify(context);
  expect(calls[2]?.model).toBe(cheap);
});

test('reuse compares validated inputs after defaults and permits distinct requests', async () => {
  const inputs = [{}, { page: 1, size: 10 }, { page: 2 }];
  let resolved = 0;
  let executed = 0;

  const result = await createAgent({
    instructions: 'Read the supplied collection.',
    model: stubModel(),
    controller: scriptedController({
      decisions: [
        ...inputs.map(() => ({ type: 'tool' as const, tool: 'read_collection' })),
        { type: 'respond', outcome: 'completed' },
      ],
    }),
    tools: {
      read_collection: agentTool({
        description: 'Read a page of collection records.',
        inputSchema: z.object({ page: z.number().default(1), size: z.number().default(10) }),
        risk: 'read',
        repeat: 'reuse',
        resolveInput: () => testFixture<{ page: number; size: number }>(inputs[resolved++]!),
        execute: (input) => {
          executed++;

          return { page: input.page };
        },
      }),
    },
  }).run({ messages: [userMessage('Read the first two pages.')] });

  expect(executed).toBe(2);
  expect(result.state.blockers.some((blocker) => blocker.kind === 'duplicate')).toBe(true);
  expect(
    result.state.observations
      .filter((observation) => observation.kind === 'tool-result')
      .map((observation) => observation.detail),
  ).toEqual([{ page: 1 }, { page: 2 }]);
});

test('invalid structured output retains provider usage and reports failed work', async () => {
  const traces: GenerationTrace[] = [];

  const usage = {
    model: { calls: 0, inputTokens: 0, outputTokens: 0 },
    controller: { calls: 0, inputTokens: 0, outputTokens: 0 },
  };

  const host = new GenerationHost({
    defaultModel: stubModel({ objects: [{ invented: true }] }),
    abortSignal: new AbortController().signal,
    usage,
    onGeneration: (trace) => traces.push(trace),
  });

  await expect(
    host.generateObject({
      purpose: 'grounded_input',
      schema: z.object({ required: z.string() }),
      prompt: 'Return the required value.',
    }),
  ).rejects.toThrow();
  expect(usage.model).toEqual({ calls: 1, inputTokens: 1, outputTokens: 1 });
  expect(traces).toMatchObject([
    {
      purpose: 'grounded_input',
      status: 'error',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ]);
});
