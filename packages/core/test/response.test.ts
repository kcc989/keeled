import { describe, expect, test } from 'bun:test';
import { createTestAgent as createAgent } from './fixtures.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';
import { searchTool } from './fixtures.ts';

describe('single reply', () => {
  for (const text of [
    '',
    '   ',
    '<tool_call name="cancel">123</tool_call>',
    '{"name":"cancel","arguments":{"id":"X"}}',
  ]) {
    test(`rejects invalid text without generating a repair: ${JSON.stringify(text)}`, async () => {
      let calls = 0;

      const result = await createAgent({
        instructions: 'Help the user.',
        controller: scriptedController({ decisions: [{ type: 'respond', outcome: 'needs_input' }] }),
        model: stubModel(),
        tools: { search: searchTool() },
        respond: async () => {
          calls++;

          return { text };
        },
      }).run({ messages: [userMessage('Cancel my trip.')] });

      expect(calls).toBe(1);
      expect(result.text).toContain('More information is needed');
      expect(result.usage.controller.calls).toBe(1);
    });
  }

  test('a reply ends the turn with one generation and no separate completion or review call', async () => {
    const controller = scriptedController({
      decisions: [
        { action: { type: 'respond', outcome: 'completed' }, confidence: 0.2 },
        { type: 'tool', tool: 'search' },
      ],
    });

    const result = await createAgent({
      instructions: 'Answer directly when no tool is needed.',
      controller,
      model: stubModel({ text: 'Four.' }),
      tools: { search: searchTool() },
    }).run({ messages: [userMessage('What is two plus two?')] });

    expect(result.text).toBe('Four.');
    expect(result.stopReason).toBe('completed');
    expect(result.state.toolCalls).toBe(0);
    expect(controller.consumed).toBe(1);
    expect(result.usage.model.calls).toBe(1);
    expect(result.usage.controller.calls).toBe(1);
  });
});
