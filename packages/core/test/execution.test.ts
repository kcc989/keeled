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

    expect(decisions).toHaveLength(9);
    expect(plans).toHaveLength(3);
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
    expect(result.plan).toMatchObject({ kind: 'implicit', version: 0, steps: [{ id: 'request' }] });
    expect(result.state.toolCalls).toBe(1);
  });

  test('a complex request expands the implicit plan before other work', async () => {
    const controller = scriptedController({
      decisions: [
        { type: 'tool', tool: 'plan' },
        { type: 'respond', outcome: 'needs_input' },
      ],
      assess: { goalMet: false },
    });
    const agent = createAgent({
      instructions: 'Complete complex work from a plan.',
      controller,
      model,
      tools: { plan: scriptedPlanner([firstPlan]), search: searchTool() },
      planningTool: 'plan',
    });

    const result = await agent.run({ messages: [userMessage('Change the helper and verify it.')] });

    expect(result.plan).toMatchObject({ kind: 'explicit', version: 1 });
    expect(result.state.observations.filter(observation => observation.kind === 'tool-result').map(o => o.tool))
      .toEqual(['plan']);
    expect(controller.contexts).toHaveLength(2);
  });

  test('offers planning at setup and once after a tool failure, but not on every cycle', async () => {
    const planningVisible: boolean[] = [];
    const failing = agentTool({
      description: 'Fail once.',
      inputSchema: z.object({}),
      risk: 'read',
      resolveInput: () => ({}),
      execute: () => {
        throw new Error('failed route');
      },
    });
    const observe = (action: { type: 'tool'; tool: string } | { type: 'respond'; outcome: 'needs_input' }) =>
      (context: ControllerContext) => {
        planningVisible.push(context.availableTools.some(tool => tool.isPlanningTool));
        return action;
      };
    const controller = scriptedController({
      decisions: [
        observe({ type: 'tool', tool: 'failing' }),
        observe({ type: 'tool', tool: 'plan' }),
        observe({ type: 'respond', outcome: 'needs_input' }),
      ],
    });
    const agent = createAgent({
      instructions: 'Complete the task.',
      controller,
      model,
      tools: { plan: scriptedPlanner([firstPlan]), failing },
      planningTool: 'plan',
    });

    const result = await agent.run({ messages: [userMessage('Do the complex task.')] });

    expect(planningVisible).toEqual([true, true, false]);
    expect(result.plan).toMatchObject({ kind: 'explicit', version: 1 });
    expect(result.stopReason).toBe('needs_input');
  });

  test('offers setup planning again when an implicit task continues after user input', async () => {
    const firstController = scriptedController({
      decisions: [{ type: 'respond', outcome: 'needs_input' }],
    });
    const definition = {
      instructions: 'Complete the task.',
      model,
      tools: { plan: scriptedPlanner([firstPlan]), search: searchTool() },
      planningTool: 'plan' as const,
    };
    const first = await createAgent({ ...definition, controller: firstController }).run({
      messages: [userMessage('Cancel my reservations.')],
    });
    expect(first.plan?.kind).toBe('implicit');

    const planningVisible: boolean[] = [];
    const continuedController = scriptedController({
      decisions: [
        context => {
          planningVisible.push(context.availableTools.some(tool => tool.isPlanningTool));
          return { type: 'tool', tool: 'plan' };
        },
        { type: 'respond', outcome: 'needs_input' },
      ],
    });
    const continued = await createAgent({ ...definition, controller: continuedController }).run({
      messages: [...first.messages, userMessage('They are A1 and B2.', 'user-2')],
    });

    expect(planningVisible).toEqual([true]);
    expect(continued.plan).toMatchObject({ kind: 'explicit', version: 1 });
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
  test('a low-confidence step completion does not end the turn', async () => {
    const controller = scriptedController({
      decisions: [
        { type: 'tool', tool: 'plan' },
        { action: { type: 'complete_step' }, confidence: 0 },
        { type: 'respond', outcome: 'needs_input' },
      ],
      assess: { goalMet: false },
    });

    const agent = createAgent({
      instructions: 'Answer the question.',
      controller,
      model,
      tools: { plan: scriptedPlanner([firstPlan]), search: searchTool() },
      planningTool: 'plan',
    });

    const result = await agent.run({ messages: [userMessage('Do the thing.')] });
    expect(result.stopReason).toBe('needs_input');
    expect(result.state.blockers.at(0)?.reason).toContain('Completion was requested');
  });

  test('the unified control operation checks the goal on every cycle', async () => {
    let assessed = 0;
    const controller = scriptedController({
      decisions: [
        { type: 'tool', tool: 'search' },
        { type: 'tool', tool: 'search' },
        { type: 'respond', outcome: 'completed' },
      ],
      assess: () => {
        assessed += 1;
        return { goalMet: true };
      },
    });

    const agent = createAgent({ instructions: 'Answer the question.', controller, model, tools: { search: searchTool() } });
    const result = await agent.run({ messages: [userMessage('Do the thing.')] });
    expect(assessed).toBe(3);
    expect(result.stopReason).toBe('completed');
    expect(result.state.goal?.outcome).toBe('passed');
  });

  test('crossing off the implicit step completes the task', async () => {
    const controller = scriptedController({
      decisions: [
        { type: 'respond', outcome: 'completed' },
        { type: 'respond', outcome: 'needs_input' },
      ],
      assess: { goalMet: true },
    });

    const agent = createAgent({ instructions: 'Answer the question.', controller, model, tools: { search: searchTool() } });
    const result = await agent.run({ messages: [userMessage('Do the thing.')] });
    expect(result.stopReason).toBe('completed');
    expect(result.state.stepStatuses).toEqual({ request: 'done' });
  });

  test('a completed step ends without another controller decision', async () => {
    const controller = scriptedController({
      decisions: [{ type: 'complete_step' }],
    });

    const agent = createAgent({ instructions: 'Answer the question.', controller, model, tools: { search: searchTool() } });
    const result = await agent.run({ messages: [userMessage('Do the thing.')] });
    expect(result.stopReason).toBe('completed');
    expect(result.state.stepsUsed).toBe(1);
    expect(controller.consumed).toBe(1);
  });

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

  test('different resolved inputs are different attempts even when none can run', async () => {
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
    expect(index).toBe(4);
    expect(result.state.blockers.filter(blocker => blocker.kind === 'no_progress')).toHaveLength(0);
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
