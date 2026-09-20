import { describe, expect, test } from 'bun:test';
import { createTestAgent as createAgent } from './fixtures.ts';
import { callHistory } from '../src/projection.ts';
import { reduceState, reducerVersion } from '../src/state.ts';
import { scriptedController, stubModel, testFixture, userMessage } from '../src/testing.ts';
import type { AgentMessage } from '../src/types.ts';
import { searchTool } from './fixtures.ts';

function agent() {
  return createAgent({
    instructions: 'Answer the question.',
    controller: scriptedController({
      decisions: [
        { type: 'tool', tool: 'search' },
        { type: 'respond', outcome: 'needs_input' },
      ],
    }),
    model: stubModel(),
    tools: { search: searchTool() },
  });
}

describe('reduceState', () => {
  test('checkpoint matches replay before the terminal transition; the next turn starts empty', async () => {
    const result = await agent().run({ messages: [userMessage('Where is it?')] });
    const last = result.messages.at(-1)!;
    const checkpoint = last.metadata!.checkpoint!;
    const parts = last.parts.filter((part) => part.type !== 'data-transition' || part.data.stopReason === undefined);
    expect(reduceState([...result.messages.slice(0, -1), { ...last, parts }])).toEqual(checkpoint.state);
    expect(checkpoint.historyPosition).toBe(parts.length);
    expect(checkpoint.reducerVersion).toBe(reducerVersion);
    expect(checkpoint.state.toolCalls).toBe(1);
    expect(checkpoint.state.stepsUsed).toBe(2);
    const next = reduceState(result.messages);
    expect(next.stepsUsed).toBe(0);
    expect(next.observations).toEqual([]);
    expect(next.stopReason).toBe('needs_input');
  });

  test('follow-up control retains the original request and tool results in conversation history', async () => {
    const first = await agent().run({ messages: [userMessage('Find the helper.')] });
    const controller = scriptedController({ decisions: [{ type: 'respond', outcome: 'completed' }] });

    const second = await createAgent({
      instructions: 'Answer the question.',
      controller,
      model: stubModel(),
      tools: { search: searchTool() },
    }).run({ messages: [...first.messages, userMessage('Show me that file.', 'user-2')] });

    const context = controller.contexts[0]!;
    expect(context.request).toBe('Show me that file.');
    expect(JSON.stringify(context.conversation)).toContain('Find the helper.');
    expect(callHistory(context.conversation, context.observations)).toMatchObject([
      { tool: 'search', input: { query: 'Find the helper.' }, result: { files: ['src/index.ts'] } },
    ]);
    expect(second.steps).toBe(1);
    // SAFETY: the test fixture intentionally models this exact compile-time shape.
    expect(second.messages.flatMap((m) => m.parts).some((p) => (p.type as string) === 'data-plan')).toBe(false);
  });

  test('legacy plan and verification records cannot gate a new request', async () => {
    // SAFETY: the test fixture intentionally models this exact compile-time shape.
    const messages = testFixture<AgentMessage[]>([
      {
        id: 'old',
        role: 'assistant',
        parts: [
          { type: 'data-plan', data: { invalid: 'legacy schema' } },
          { type: 'data-verification', data: { invalid: 'legacy schema' } },
          { type: 'data-fact', data: { invalid: 'legacy schema' } },
        ],
      },
    ]);

    expect(reduceState(messages)).toEqual(reduceState([]));
    expect(reduceState([]).reducerVersion).toBe(4);
  });
});
