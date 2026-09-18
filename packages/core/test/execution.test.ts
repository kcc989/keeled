import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createAgent } from '../src/agent.ts';
import { agentTool } from '../src/tool.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';
import type { ControllerContext } from '../src/controller.ts';
import type { AgentMessage } from '../src/types.ts';
import {
  editTool,
  firstPlan,
  revisedPlan,
  scriptedPlanner,
  searchTool,
  testTool,
} from './fixtures.ts';

const model = stubModel({ text: 'The change is applied and the tests pass.' });

function succeeded(context: ControllerContext, tool: string): boolean {
  return context.state.observations.some(
    observation => observation.kind === 'tool-result' && observation.tool === tool,
  );
}

function fullRun() {
  const controller = scriptedController({
    decisions: [
      { type: 'tool', tool: 'plan' },
      { type: 'tool', tool: 'search', stepId: 'locate' },
      { type: 'tool', tool: 'editFile', stepId: 'edit' },
      { type: 'tool', tool: 'plan' },
      { type: 'tool', tool: 'editFile', stepId: 'edit' },
      { type: 'tool', tool: 'runTests', stepId: 'verify' },
      { type: 'respond', outcome: 'completed' },
    ],
    assess: context => ({
      steps: {
        locate: { complete: succeeded(context, 'search') },
        edit: { complete: succeeded(context, 'editFile') },
        verify: { complete: succeeded(context, 'runTests') },
      },
      goalMet: succeeded(context, 'runTests'),
    }),
  });

  const agent = createAgent({
    instructions: 'Complete the requested change and verify the result.',
    controller,
    model,
    tools: {
      plan: scriptedPlanner([firstPlan, revisedPlan]),
      search: searchTool(),
      editFile: editTool({ failFirst: true }),
      runTests: testTool(),
    },
    planningTool: 'plan',
    policy: { maxSteps: 12 },
  });

  return { agent, controller };
}

describe('phase 1 demonstration', () => {
  test('selects several tools, plans, revises after a failure, and answers', async () => {
    const { agent } = fullRun();
    const result = await agent.run({ messages: [userMessage('Rename the exported helper.')] });

    expect(result.stopReason).toBe('completed');
    expect(result.plan?.version).toBe(2);
    expect(result.text).toContain('applied');

    const parts = result.messages.at(-1)?.parts ?? [];
    const decisions = parts.filter(part => part.type === 'data-decision');
    const plans = parts.filter(part => part.type === 'data-plan');
    const toolErrors = parts.filter(
      part => part.type.startsWith('tool-') && (part as { state?: string }).state === 'output-error',
    );

    expect(decisions).toHaveLength(7);
    expect(plans).toHaveLength(2);
    expect(toolErrors).toHaveLength(1);
    expect(result.state.stepStatuses).toEqual({ locate: 'done', edit: 'done', verify: 'done' });
  });

  test('a simple request skips planning', async () => {
    const controller = scriptedController({
      decisions: [
        { type: 'tool', tool: 'search' },
        { type: 'respond', outcome: 'completed' },
      ],
      assess: context => ({ goalMet: succeeded(context, 'search') }),
    });

    const agent = createAgent({
      instructions: 'Answer the question.',
      controller,
      model,
      tools: { plan: scriptedPlanner([firstPlan]), search: searchTool() },
      planningTool: 'plan',
    });

    const result = await agent.run({ messages: [userMessage('Where is the helper defined?')] });
    expect(result.stopReason).toBe('completed');
    expect(result.plan).toBeUndefined();
    expect(result.state.toolCalls).toBe(1);
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
  test('a blocked completion does not end the turn', async () => {
    const controller = scriptedController({
      decisions: [
        { type: 'respond', outcome: 'completed' },
        { type: 'respond', outcome: 'needs_input' },
      ],
      assess: { goalMet: false },
    });

    const agent = createAgent({
      instructions: 'Answer the question.',
      controller,
      model,
      tools: { search: searchTool() },
    });

    const result = await agent.run({ messages: [userMessage('Do the thing.')] });
    expect(result.stopReason).toBe('needs_input');
    expect(result.state.blockers.at(0)?.reason).toContain('Completion was requested');
  });

  test('the step limit produces a useful response', async () => {
    const controller = scriptedController({
      decisions: Array.from({ length: 10 }, () => ({ type: 'tool', tool: 'search' }) as const),
      assess: { goalMet: false },
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
      assess: { goalMet: false },
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
      assess: { goalMet: false },
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
    expect(result.text).toBe('');
  });

  test('selecting an unregistered tool is rejected rather than executed', async () => {
    const controller = scriptedController({
      decisions: [{ type: 'tool', tool: 'ghost' }],
      assess: { goalMet: false },
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
      assess: { goalMet: false },
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
      assess: { goalMet: false },
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
      assess: { goalMet: true },
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
      assess: { goalMet: false },
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
