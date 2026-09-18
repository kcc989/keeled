import { describe, expect, test } from 'bun:test';
import { createAgent } from '../src/agent.ts';
import type { Compactor } from '../src/compaction.ts';
import { ConfigurationError } from '../src/errors.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';
import type { AgentMessage, TransitionRecord } from '../src/types.ts';
import { searchTool } from './fixtures.ts';

function agent(compaction?: Parameters<typeof createAgent>[0]['compaction']) {
  return createAgent({
    instructions: 'Answer the question.',
    controller: scriptedController({
      decisions: [{ type: 'tool', tool: 'search' }, { type: 'respond', outcome: 'completed' }],
      assess: { goalMet: true },
    }),
    model: stubModel({ text: 'Done.' }),
    tools: { search: searchTool() },
    compaction,
  });
}

const history: AgentMessage[] = [
  userMessage('Where is it?', 'u1'),
  { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'x'.repeat(500) }] },
  userMessage('And now?', 'u2'),
];

function compactionTransitions(messages: AgentMessage[]): TransitionRecord[] {
  return (messages.at(-1)?.parts ?? [])
    .filter(part => part.type === 'data-transition')
    .map(part => (part as { data: TransitionRecord }).data)
    .filter(record => record.kind === 'compaction');
}

describe('compaction', () => {
  test('is off unless configured', async () => {
    const result = await agent().run({ messages: history });
    expect(result.messages.slice(0, 3)).toEqual(history);
    expect(compactionTransitions(result.messages)).toHaveLength(0);
  });

  test('does not run under the threshold', async () => {
    let calls = 0;
    const compactor: Compactor = async messages => {
      calls += 1;
      return { messages: [...messages] };
    };
    await agent({ compactor, thresholdChars: 1_000_000 }).run({ messages: history });
    expect(calls).toBe(0);
  });

  test('runs the turn on the compacted history and records it', async () => {
    let signal: AbortSignal | undefined;
    const compactor: Compactor = async (messages, context) => {
      signal = context.abortSignal;
      return {
        messages: messages.filter(message => message.id !== 'a1'),
        usage: { calls: 1, inputTokens: 40, outputTokens: 2 },
        detail: 'Dropped a1.',
      };
    };

    const result = await agent({ compactor, thresholdChars: 100 }).run({ messages: history });

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(result.stopReason).toBe('completed');
    expect(result.messages.map(message => message.id).slice(0, 2)).toEqual(['u1', 'u2']);
    expect(result.messages).toHaveLength(3);
    const [transition] = compactionTransitions(result.messages);
    expect(transition?.detail).toMatch(/^Compacted the history from \d+ to \d+ characters\. Dropped a1\.$/);
    // The scripted controller spends one call per decision and assessment; compaction adds one.
    expect(result.usage.controller.inputTokens).toBe(40);
  });

  test('keeps the full history when the compactor fails', async () => {
    const compactor: Compactor = async () => {
      throw new Error('Jev is unavailable');
    };
    const result = await agent({ compactor, thresholdChars: 0 }).run({ messages: history });

    expect(result.stopReason).toBe('completed');
    expect(result.messages.slice(0, 3)).toEqual(history);
    const [transition] = compactionTransitions(result.messages);
    expect(transition?.detail).toBe('Compaction failed; the full history was kept. Jev is unavailable');
  });

  test('rejects a negative threshold', () => {
    const compactor: Compactor = async messages => ({ messages: [...messages] });
    expect(() => agent({ compactor, thresholdChars: -1 })).toThrow(ConfigurationError);
  });
});
