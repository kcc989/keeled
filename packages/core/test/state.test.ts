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
            complete: context.state.observations.some(o => o.kind === 'tool-result'),
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

    // The terminal transition closes the turn, so replay starts the next one clean.
    expect(replayed.stepsUsed).toBe(0);
    expect(replayed.stopReason).toBe('needs_input');
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
    expect(partial.stepsUsed).toBe(3);
    expect(partial.stopReason).toBeUndefined();
  });

  test('state starts empty', () => {
    expect(reduceState([]).stepsUsed).toBe(0);
    expect(reduceState([]).reducerVersion).toBe(reducerVersion);
  });
});
