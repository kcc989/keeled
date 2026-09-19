import { describe, expect, test } from 'bun:test';
import { createAgent } from '../src/agent.ts';
import { reduceState, reducerVersion } from '../src/state.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';
import type { AgentMessage } from '../src/types.ts';
import { firstPlan, scriptedPlanner, searchTool } from './fixtures.ts';

const model = stubModel({ text: 'Done.' });

function agent() {
  return createAgent({
    instructions: 'Answer the question.',
    controller: scriptedController({
      decisions: [
        { type: 'tool', tool: 'plan' },
        { type: 'tool', tool: 'search', stepId: 'locate' },
        { type: 'respond', outcome: 'needs_input' },
      ],
      assess: context => ({
        steps: {
          locate: {
            complete: context.state.observations.some(o => o.kind === 'tool-result' && o.tool === 'search'),
          },
        },
        goalMet: false,
      }),
    }),
    model,
    tools: { plan: scriptedPlanner([firstPlan]), search: searchTool() },
    planningTool: 'plan',
  });
}

describe('reduceState', () => {
  test('replay reconstructs the same state the live turn held', async () => {
    const result = await agent().run({ messages: [userMessage('Where is it?')] });
    const replayed = reduceState(result.messages);
    const checkpoint = result.messages.at(-1)?.metadata?.checkpoint;

    expect(checkpoint?.reducerVersion).toBe(reducerVersion);
    expect(checkpoint?.state.plan?.version).toBe(1);
    expect(checkpoint?.state.stepStatuses['locate']).toBe('done');
    expect(checkpoint?.state.toolCalls).toBe(2);

    // The terminal transition clears loop-local state but preserves the task.
    expect(replayed.stepsUsed).toBe(0);
    expect(replayed.toolCalls).toBe(0);
    expect(replayed.observations).toEqual([]);
    expect(replayed.blockers).toEqual([]);
    expect(replayed.plan).toMatchObject({ kind: 'explicit', version: 1 });
    expect(replayed.stepStatuses['locate']).toBe('done');
    expect(replayed.plan?.steps.find(step => step.id === 'locate')?.evidence).toHaveLength(1);
    expect(replayed.stopReason).toBe('needs_input');
  });

  test('a follow-up message updates the durable task without replacing its plan', async () => {
    const first = await agent().run({ messages: [userMessage('Cancel my reservation.')] });
    const controller = scriptedController({
      decisions: [{ type: 'respond', outcome: 'needs_input' }],
      assess: {
        steps: { locate: { complete: true }, edit: { complete: false }, verify: { complete: false } },
        goalMet: false,
      },
    });
    const continued = createAgent({
      instructions: 'Answer the question.',
      controller,
      model,
      tools: { plan: scriptedPlanner([firstPlan]), search: searchTool() },
      planningTool: 'plan',
    });

    const second = await continued.run({
      messages: [...first.messages, userMessage("I'm sick.", 'user-2')],
    });
    const context = controller.contexts[0];

    expect(context?.request).toBe("I'm sick.");
    expect(context?.plan).toMatchObject({
      id: first.plan?.id,
      version: 1,
      kind: 'explicit',
      objective: firstPlan.objective,
    });
    expect(context?.stepStatuses['locate']).toBe('done');
    expect(context?.plan?.steps.find(step => step.id === 'locate')?.evidence).toHaveLength(1);
    expect(context?.observations).toEqual([]);
    expect(second.messages.at(-1)?.parts.filter(part => part.type === 'data-plan')).toHaveLength(0);
  });

  test('an interrupted turn reduces to the state reached so far', async () => {
    const result = await agent().run({ messages: [userMessage('Where is it?')] });
    const last = result.messages.at(-1) as AgentMessage;
    const truncated: AgentMessage = {
      ...last,
      parts: last.parts.filter(part => {
        if (part.type !== 'data-transition') return true;
        return (part as { data: { stopReason?: string } }).data.stopReason === undefined;
      }),
    };

    const partial = reduceState([...result.messages.slice(0, -1), truncated]);
    expect(partial.plan?.version).toBe(1);
    expect(partial.stepsUsed).toBe(4);
    expect(partial.stopReason).toBeUndefined();
  });

  test('a terminal task does not lend its plan to the next request', async () => {
    const completed = createAgent({
      instructions: 'Answer the question.',
      controller: scriptedController({
        decisions: [{ type: 'respond', outcome: 'completed' }],
        assess: { goalMet: true },
      }),
      model,
      tools: { search: searchTool() },
    });

    const result = await completed.run({ messages: [userMessage('What is two plus two?')] });
    const next = reduceState(result.messages);

    expect(result.plan).toMatchObject({ kind: 'implicit', objective: 'What is two plus two?' });
    expect(next.plan).toBeUndefined();
    expect(next.stopReason).toBe('completed');
  });

  test('state starts empty', () => {
    expect(reduceState([]).stepsUsed).toBe(0);
    expect(reduceState([]).reducerVersion).toBe(reducerVersion);
  });
});
