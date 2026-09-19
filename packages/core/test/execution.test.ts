import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createTestAgent as createAgent } from './fixtures.ts';
import { agentTool } from '../src/tool.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';
import type { ControllerContext } from '../src/controller.ts';
import type { AgentMessage } from '../src/types.ts';
import {
  editTool,
  searchTool,
  testTool,
} from './fixtures.ts';

const model = stubModel({ text: 'The change is applied and the tests pass.' });

function fullRun() {
  const controller = scriptedController({
    decisions: [
      { type: 'tool', tool: 'search' },
      { type: 'tool', tool: 'editFile' },
      { type: 'tool', tool: 'editFile' },
      { type: 'tool', tool: 'runTests' },
      { type: 'respond', outcome: 'completed' },
    ],
  });

  const agent = createAgent({
    instructions: 'Complete the requested change and verify the result.',
    controller,
    model,
    tools: {
      search: searchTool(),
      editFile: editTool({ failFirst: true }),
      runTests: testTool(),
    },
    policy: { maxSteps: 12 },
  });

  return { agent, controller };
}

describe('simple loop', () => {
  test('selects tools and stops further writes after an uncertain failure', async () => {
    const { agent } = fullRun();
    const result = await agent.run({ messages: [userMessage('Rename the exported helper.')] });

    expect(result.stopReason).toBe('blocked');
    expect(result.state.uncertainOperations).toHaveLength(1);
    expect(result.state.observations.filter(o => o.kind === 'tool-result' && o.tool === 'editFile')).toHaveLength(0);

    expect(result.text.length).toBeGreaterThan(0);

    const parts = result.messages.at(-1)?.parts ?? [];
    const decisions = parts.filter(part => part.type === 'data-decision');

    const toolErrors = parts.filter(
      part => part.type.startsWith('tool-') && (part as { state?: string }).state === 'output-error',
    );

    expect(decisions).toHaveLength(5);

    expect(toolErrors).toHaveLength(1);

  });

  test('run and stream produce the same messages and text', async () => {
    const direct = await fullRun().agent.run({
      messages: [userMessage('Rename the exported helper.')],
    });

    const execution = fullRun().agent.stream({
      messages: [userMessage('Rename the exported helper.')],
    });
    const chunks: unknown[] = [];
    for await (const chunk of execution) chunks.push(chunk);
    const streamed = await execution.result;

    expect(streamed.text).toBe(direct.text);
    expect(streamed.stopReason).toBe(direct.stopReason);
    expect(streamed.messages.at(-1)?.parts.map(part => part.type)).toEqual(
      direct.messages.at(-1)?.parts.map(part => part.type) ?? [],
    );
    expect(chunks.length).toBeGreaterThan(0);
  });

  test('exposes a UI message stream response', async () => {
    const execution = fullRun().agent.stream({ messages: [userMessage('Rename it.')] });
    const response = execution.toUIMessageStreamResponse();
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('data-decision');
    await execution.result;
  });
});

describe('termination paths', () => {
  test('alternating between two actions without new evidence is reported, then ends the turn', async () => {
    const lookup = agentTool({
      description: 'Look something up.',
      inputSchema: z.object({}),
      risk: 'read',
      resolveInput: () => ({}),
      execute: () => ({ same: true }),
    });
    const other = agentTool({
      description: 'Look something else up.',
      inputSchema: z.object({}),
      risk: 'read',
      resolveInput: () => ({}),
      execute: () => ({ same: true }),
    });
    const controller = scriptedController({
      decisions: Array.from({ length: 20 }, (_, index) => ({ type: 'tool', tool: index % 2 === 0 ? 'lookup' : 'other' }) as const),
    });
    const agent = createAgent({ instructions: 'Find it.', controller, model, tools: { lookup, other } });
    const result = await agent.run({ messages: [userMessage('Find it.')] });
    expect(result.stopReason).toBe('blocked');
    const reports = result.state.blockers.filter(blocker => blocker.kind === 'no_progress');
    expect(reports[0]?.reason).toContain('alternated');
    expect(reports).toHaveLength(2);
  });

  test('a polling tool may repeat within its time limit', async () => {
    let polls = 0;
    const status = agentTool({
      description: 'Check job status.',
      inputSchema: z.object({}),
      risk: 'read',
      repeat: 'poll',
      pollTimeoutMs: 60_000,
      resolveInput: () => ({}),
      execute: () => {
        polls += 1;
        return { state: 'running' };
      },
    });
    const controller = scriptedController({
      decisions: [...Array.from({ length: 8 }, () => ({ type: 'tool', tool: 'status' }) as const), { type: 'respond', outcome: 'needs_input' }],
    });
    const agent = createAgent({ instructions: 'Wait for the job.', controller, model, tools: { status } });
    const result = await agent.run({ messages: [userMessage('Is it done?')] });
    expect(polls).toBe(8);
    expect(result.state.blockers).toHaveLength(0);
    expect(result.stopReason).toBe('needs_input');
  });

  test('the step limit produces a useful response', async () => {
    const controller = scriptedController({
      decisions: Array.from({ length: 10 }, () => ({ type: 'tool', tool: 'search' }) as const),

    });

    const agent = createAgent({
      instructions: 'Answer the question.',
      controller,
      model,
      tools: { search: searchTool() },
      policy: { maxSteps: 3, repeatLimit: 99 },
    });

    const result = await agent.run({ messages: [userMessage('Search forever.')] });
    expect(result.stopReason).toBe('limit');
    expect(result.steps).toBe(3);
    expect(result.text.length).toBeGreaterThan(0);
  });

  test('repeating an action without new evidence stops the turn', async () => {
    const stuck = agentTool({
      description: 'Never produces evidence.',
      inputSchema: z.object({}),
      risk: 'read',
      resolveInput: () => ({}),
      execute: () => {
        throw new Error('still failing');
      },
    });

    const controller = scriptedController({
      decisions: Array.from({ length: 10 }, () => ({ type: 'tool', tool: 'stuck' }) as const),

    });

    const agent = createAgent({
      instructions: 'Try the thing.',
      controller,
      model,
      tools: { stuck },
      policy: { maxSteps: 20, repeatLimit: 3 },
    });

    const result = await agent.run({ messages: [userMessage('Try it.')] });
    expect(result.stopReason).toBe('blocked');
    expect(result.steps).toBeLessThan(20);
  });

  test('invalid resolution is suspended rather than regenerated against unchanged evidence', async () => {
    let index = 0;
    const lookup = agentTool({
      description: 'Look up one record.',
      inputSchema: z.object({ id: z.string().min(100) }),
      risk: 'read',
      resolveInput: () => ({ id: `record-${++index}` }),
      execute: () => ({ ok: true }),
    });
    const controller = scriptedController({
      decisions: [
        { type: 'tool', tool: 'lookup' },
        { type: 'tool', tool: 'lookup' },
        { type: 'tool', tool: 'lookup' },
        { type: 'tool', tool: 'lookup' },
        { type: 'respond', outcome: 'blocked' },
      ],
    });
    const agent = createAgent({
      instructions: 'Inspect each known record.',
      controller,
      model,
      tools: { lookup },
      policy: { repeatLimit: 2 },
    });

    const result = await agent.run({ messages: [userMessage('Inspect four records.')] });

    expect(result.stopReason).toBe('blocked');
    expect(index).toBe(1);
    expect(result.state.blockers.some(blocker => blocker.kind === 'no_progress')).toBe(true);
  });

  test('cancellation stops work and preserves partial text', async () => {
    const abort = new AbortController();
    const controller = scriptedController({
      decisions: [
        context => {
          abort.abort();
          void context;
          return { type: 'tool', tool: 'search' };
        },
        { type: 'respond', outcome: 'completed' },
      ],

    });

    const agent = createAgent({
      instructions: 'Answer the question.',
      controller,
      model,
      tools: { search: searchTool() },
    });

    const result = await agent.run({
      messages: [userMessage('Start then cancel.')],
      abortSignal: abort.signal,
    });

    expect(result.stopReason).toBe('cancelled');
    expect(result.text).toBe('This turn was cancelled.');
  });

  test('selecting an unregistered tool is rejected rather than executed', async () => {
    const controller = scriptedController({
      decisions: [{ type: 'tool', tool: 'ghost' }],

    });

    const agent = createAgent({
      instructions: 'Answer the question.',
      controller,
      model,
      tools: { search: searchTool() },
    });

    const result = await agent.run({ messages: [userMessage('Use a tool that does not exist.')] });
    expect(result.stopReason).toBe('blocked');
    expect(result.state.toolCalls).toBe(0);
  });
});

describe('input resolution', () => {
  test('a resolver failure blocks the call and is recorded as evidence', async () => {
    const broken = agentTool({
      description: 'Has a failing resolver.',
      inputSchema: z.object({ value: z.string() }),
      risk: 'read',
      resolveInput: () => {
        throw new Error('no value available');
      },
      execute: () => ({ ok: true }),
    });

    const controller = scriptedController({
      decisions: [
        { type: 'tool', tool: 'broken' },
        { type: 'respond', outcome: 'needs_input' },
      ],

    });

    const agent = createAgent({
      instructions: 'Answer the question.',
      controller,
      model,
      tools: { broken },
    });

    const result = await agent.run({ messages: [userMessage('Go.')] });
    expect(result.stopReason).toBe('needs_input');
    expect(result.state.toolCalls).toBe(0);
    expect(result.state.blockers.at(0)?.reason).toContain('Input resolution failed');
  });

  test('input that fails schema validation never reaches execute', async () => {
    let executed = false;
    const mistyped = agentTool({
      description: 'Receives invalid input.',
      inputSchema: z.object({ count: z.number() }),
      risk: 'read',
      resolveInput: () => ({ count: 'not a number' } as never),
      execute: () => {
        executed = true;
        return { ok: true };
      },
    });

    const controller = scriptedController({
      decisions: [
        { type: 'tool', tool: 'mistyped' },
        { type: 'respond', outcome: 'blocked' },
      ],

    });

    const agent = createAgent({
      instructions: 'Answer the question.',
      controller,
      model,
      tools: { mistyped },
    });

    const result = await agent.run({ messages: [userMessage('Go.')] });
    expect(executed).toBe(false);
    expect(result.state.blockers.at(0)?.reason).toContain('schema validation');
    expect(result.state.blockers[0]).toMatchObject({ tool: 'mistyped', input: { count: 'not a number' } });
  });

  test('a generated input is used when no resolver is supplied', async () => {
    const seen: unknown[] = [];
    const generated = agentTool({
      description: 'Uses generated input.',
      inputSchema: z.object({ query: z.string() }),
      risk: 'read',
      execute: input => {
        seen.push(input);
        return { ok: true };
      },
    });

    const controller = scriptedController({
      decisions: [
        { type: 'tool', tool: 'generated' },
        { type: 'respond', outcome: 'completed' },
      ],

    });

    const agent = createAgent({
      instructions: 'Answer the question.',
      controller,
      model: stubModel({ text: 'Done.', objects: [{ query: 'helper export' }] }),
      tools: { generated },
    });

    const result = await agent.run({ messages: [userMessage('Find the helper.')] });
    expect(seen).toEqual([{ query: 'helper export' }]);
    expect(result.stopReason).toBe('completed');
  });
});

describe('policy', () => {
  test('a disallowed risk class blocks execution', async () => {
    const controller = scriptedController({
      decisions: [
        { type: 'tool', tool: 'editFile' },
        { type: 'respond', outcome: 'blocked' },
      ],

    });

    const agent = createAgent({
      instructions: 'Answer the question.',
      controller,
      model,
      tools: { editFile: editTool() },
      policy: { allowedRisks: ['read'] },
    });

    const result = await agent.run({ messages: [userMessage('Edit it.')] });
    expect(result.state.toolCalls).toBe(0);
    expect(result.state.blockers.at(0)?.reason).toContain('risk "write"');
  });

  test('input messages are not mutated', async () => {
    const messages: AgentMessage[] = [userMessage('Do it.')];
    const snapshot = JSON.stringify(messages);
    await fullRun().agent.run({ messages });
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});
