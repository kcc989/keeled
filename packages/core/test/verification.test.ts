import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createAgent } from '../src/agent.ts';
import { reduceState } from '../src/state.ts';
import { agentTool } from '../src/tool.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';
import type { AgentMessage, Observation } from '../src/types.ts';
import type { PlanProposal } from '../src/plan.ts';

const twoSteps: PlanProposal = {
  objective: 'Two dependent steps',
  steps: [
    { id: 'a', objective: 'Do A', dependencies: [] },
    { id: 'b', objective: 'Do B', dependencies: ['a'] },
  ],
};

function planner(proposal: PlanProposal = twoSteps) {
  return agentTool({
    description: 'Create or revise the plan.',
    inputSchema: z.object({}),
    risk: 'read',
    resolveInput: () => ({}),
    execute: (): PlanProposal => proposal,
  });
}

/** Returns an unrelated `stepId` field, which must not become the attribution. */
const work = agentTool({
  description: 'Do the work.',
  inputSchema: z.object({}),
  risk: 'read',
  resolveInput: () => ({}),
  execute: () => ({ ok: true, stepId: 'a-record-id-from-some-other-system' }),
});

const failing = agentTool({
  description: 'Always fails.',
  inputSchema: z.object({}),
  risk: 'read',
  resolveInput: () => ({}),
  execute: () => {
    throw new Error('nope');
  },
});

const model = stubModel({ text: 'Done.' });

const walkThrough = [
  { type: 'tool', tool: 'plan' },
  { type: 'tool', tool: 'work', stepId: 'a' },
  { type: 'tool', tool: 'work', stepId: 'b' },
  { type: 'respond', outcome: 'completed' },
] as const;

describe('non-monotonic assessment', () => {
  test('a confidence dip does not un-complete a verified step', async () => {
    const agent = createAgent({
      instructions: 'Do the work.',
      controller: scriptedController({
        decisions: [...walkThrough],
        assess: context => {
          const cycle = context.state.cycle + 1;
          // Step a verifies, then its confidence collapses below the floor.
          return {
            steps: {
              a: { complete: true, confidence: cycle >= 4 ? 0.3 : 1 },
              b: { complete: cycle >= 4, confidence: 1 },
            },
            goalMet: cycle >= 4,
          };
        },
      }),
      model,
      tools: { plan: planner(), work },
      planningTool: 'plan',
      policy: { maxSteps: 10 },
    });

    const result = await agent.run({ messages: [userMessage('go')] });

    expect(result.stopReason).toBe('completed');
    expect(result.state.stepStatuses).toEqual({ a: 'done', b: 'done' });
    expect(result.state.verification['a']?.outcome).toBe('passed');
    expect(result.state.blockers).toHaveLength(0);
  });

  test('a goal that passed is not withdrawn by a later uncertain pass', async () => {
    const oneStep: PlanProposal = {
      objective: 'One step',
      steps: [{ id: 'a', objective: 'Do A', dependencies: [] }],
    };
    let assessed = 0;
    const agent = createAgent({
      instructions: 'Do the work.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'plan' },
          { type: 'tool', tool: 'work', stepId: 'a' },
          { type: 'respond', outcome: 'completed' },
        ],
        assess: () => {
          assessed += 1;
          return { steps: { a: { complete: true } }, goalMet: true, goalConfidence: assessed >= 2 ? 0.2 : 1 };
        },
      }),
      model,
      tools: { plan: planner(oneStep), work },
      planningTool: 'plan',
      policy: { maxSteps: 8 },
    });

    const result = await agent.run({ messages: [userMessage('go')] });
    expect(result.stopReason).toBe('completed');
    expect(result.state.goal?.outcome).toBe('passed');
  });

  test('an evidence-backed failure still regresses a completed step', async () => {
    let cycle = 0;
    const agent = createAgent({
      instructions: 'Do the work.',
      controller: scriptedController({
        decisions: [...walkThrough],
        assess: () => {
          cycle += 1;
          // Confident that a is no longer complete: that is evidence, not absence.
          return {
            steps: {
              a: { complete: cycle < 4, confidence: 1 },
              b: { complete: cycle >= 4, confidence: 1 },
            },
            goalMet: false,
          };
        },
      }),
      model,
      tools: { plan: planner(), work },
      planningTool: 'plan',
      policy: { maxSteps: 10 },
    });

    const result = await agent.run({ messages: [userMessage('go')] });
    expect(result.state.stepStatuses['a']).toBe('pending');
    expect(result.state.verification['a']?.outcome).toBe('failed');
    expect(result.stopReason).toBe('blocked');
  });

  test('a plan revision still invalidates the result it changed', async () => {
    const revised: PlanProposal = {
      objective: 'Two dependent steps',
      steps: [
        { id: 'a', objective: 'Do A differently', dependencies: [] },
        { id: 'b', objective: 'Do B', dependencies: ['a'] },
      ],
    };
    let planIndex = 0;
    const revising = agentTool({
      description: 'Create or revise the plan.',
      inputSchema: z.object({}),
      risk: 'read',
      resolveInput: () => ({}),
      execute: (): PlanProposal => (planIndex++ === 0 ? twoSteps : revised),
    });

    const agent = createAgent({
      instructions: 'Do the work.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'plan' },
          { type: 'tool', tool: 'work', stepId: 'a' },
          { type: 'tool', tool: 'plan' },
          { type: 'respond', outcome: 'needs_input' },
        ],
        assess: context => ({
          steps: {
            a: { complete: context.state.plan?.version === 1, confidence: 1 },
            b: { complete: false, confidence: 1 },
          },
          goalMet: false,
        }),
      }),
      model,
      tools: { plan: revising, work },
      planningTool: 'plan',
      policy: { maxSteps: 10 },
    });

    const result = await agent.run({ messages: [userMessage('go')] });
    expect(result.plan?.version).toBe(2);
    expect(result.state.verification['a']?.planVersion).toBe(2);
    expect(result.state.verification['a']?.outcome).not.toBe('passed');
  });
});

describe('step attribution', () => {
  function observationsOf(result: { state: { observations: Observation[] } }, tool: string) {
    return result.state.observations.filter(o => o.tool === tool);
  }

  test('a tool observation takes its step from the decision, not the tool output', async () => {
    const agent = createAgent({
      instructions: 'Do the work.',
      controller: scriptedController({
        decisions: [...walkThrough],
        assess: context => ({
          steps: {
            a: { complete: context.state.toolCalls >= 2, confidence: 1 },
            b: { complete: context.state.toolCalls >= 3, confidence: 1 },
          },
          goalMet: context.state.toolCalls >= 3,
        }),
      }),
      model,
      tools: { plan: planner(), work },
      planningTool: 'plan',
      policy: { maxSteps: 10 },
    });

    const result = await agent.run({ messages: [userMessage('go')] });
    expect(observationsOf(result, 'work').map(o => o.stepId)).toEqual(['a', 'b']);
    expect(result.stopReason).toBe('completed');
  });

  test('a tool failure is attributed to the same step', async () => {
    const agent = createAgent({
      instructions: 'Do the work.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'plan' },
          { type: 'tool', tool: 'failing', stepId: 'a' },
          { type: 'respond', outcome: 'blocked' },
        ],
        assess: { goalMet: false },
      }),
      model,
      tools: { plan: planner(), failing },
      planningTool: 'plan',
      policy: { maxSteps: 10 },
    });

    const result = await agent.run({ messages: [userMessage('go')] });
    const errors = result.state.observations.filter(o => o.kind === 'tool-error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.stepId).toBe('a');
    expect(errors[0]?.tool).toBe('failing');
  });

  test('a call made outside any step carries no step', async () => {
    const agent = createAgent({
      instructions: 'Do the work.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'work' },
          { type: 'respond', outcome: 'completed' },
        ],
        assess: { goalMet: true },
      }),
      model,
      tools: { work },
    });

    const result = await agent.run({ messages: [userMessage('go')] });
    expect(observationsOf(result, 'work')[0]?.stepId).toBeUndefined();
  });
});

describe('state checkpoint', () => {
  test('the checkpoint agrees with reducing the same parts', async () => {
    const agent = createAgent({
      instructions: 'Do the work.',
      controller: scriptedController({
        decisions: [...walkThrough],
        assess: context => ({
          steps: {
            a: { complete: context.state.toolCalls >= 2, confidence: 1 },
            b: { complete: context.state.toolCalls >= 3, confidence: 1 },
          },
          goalMet: context.state.toolCalls >= 3,
        }),
      }),
      model,
      tools: { plan: planner(), work },
      planningTool: 'plan',
      policy: { maxSteps: 10 },
    });

    const result = await agent.run({ messages: [userMessage('go')] });
    const last = result.messages.at(-1) as AgentMessage;
    const checkpoint = last.metadata?.checkpoint;
    expect(checkpoint).toBeDefined();

    // The checkpoint is taken before the terminal transition closes the turn, so
    // reducing the parts up to that point must reproduce it exactly.
    const upToClose = last.parts.filter(part => {
      if (part.type !== 'data-transition') return true;
      return (part as { data: { stopReason?: string } }).data.stopReason === undefined;
    });
    const replayed = reduceState([...result.messages.slice(0, -1), { ...last, parts: upToClose }]);

    expect(replayed).toEqual(checkpoint!.state);
    expect(checkpoint!.historyPosition).toBe(upToClose.length);
  });
});
