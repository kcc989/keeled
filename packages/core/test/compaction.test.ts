import { describe, expect, test } from 'bun:test';
import { createAgent } from '../src/agent.ts';
import { compactedView, type Compactor } from '../src/compaction.ts';
import { ConfigurationError } from '../src/errors.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';
import type { AgentMessage, CompactionRecord } from '../src/types.ts';
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

/** A finished first turn and a new request: [u1, a1, u2]. */
async function history(): Promise<AgentMessage[]> {
  const first = await agent().run({ messages: [userMessage('Where is it?', 'u1')] });
  return [...first.messages, userMessage('And now?', 'u2')];
}

function records(messages: readonly AgentMessage[]): CompactionRecord[] {
  return messages.flatMap(message =>
    message.parts
      .filter(part => part.type === 'data-compaction')
      .map(part => (part as { data: CompactionRecord }).data),
  );
}

function toolCallIds(message: AgentMessage | undefined): string[] {
  return (message?.parts ?? [])
    .filter(part => part.type.startsWith('tool-'))
    .map(part => (part as unknown as { toolCallId: string }).toolCallId);
}

/** Removes every tool call in the first assistant message. */
const dropFirstTurnTools: Compactor = async view => {
  const tools = Object.fromEntries(toolCallIds(view[1]).map(id => [id, { remove: true as const }]));
  return { edit: { tools }, usage: { calls: 1, inputTokens: 40, outputTokens: 2 }, detail: 'Dropped a1 tools.' };
};

describe('compaction', () => {
  test('is off unless configured', async () => {
    const messages = await history();
    const result = await agent().run({ messages });
    expect(result.messages.slice(0, 3)).toEqual(messages);
    expect(records(result.messages)).toHaveLength(0);
  });

  test('does not run under the threshold', async () => {
    let calls = 0;
    const compactor: Compactor = async () => {
      calls += 1;
      return {};
    };
    await agent({ compactor, thresholdChars: 1_000_000 }).run({ messages: await history() });
    expect(calls).toBe(0);
  });

  test('never changes the stored history, and records the edit', async () => {
    const messages = await history();
    const result = await agent({ compactor: dropFirstTurnTools, thresholdChars: 0 }).run({ messages });

    expect(result.stopReason).toBe('completed');
    expect(result.messages.slice(0, 3)).toEqual(messages);
    expect(toolCallIds(result.messages[1])).toHaveLength(1);

    const [record] = records(result.messages);
    expect(record).toMatchObject({ outcome: 'applied', detail: 'Dropped a1 tools.' });
    expect(record!.charsAfter).toBeLessThan(record!.charsBefore);
    expect(result.usage.controller.inputTokens).toBe(40);

    // The view the next turn reads applies the recorded edit.
    const view = compactedView(result.messages);
    expect(toolCallIds(view[1])).toHaveLength(0);
    expect(view[0]).toBe(result.messages[0]!);
  });

  test('the turn reads the compacted view', async () => {
    const messages = await history();
    const seen: number[] = [];
    const tracked = createAgent({
      instructions: 'Answer the question.',
      controller: scriptedController({
        decisions: [
          context => {
            seen.push(toolCallIds(context.conversation[1] as AgentMessage).length);
            return { type: 'respond', outcome: 'completed' };
          },
        ],
        assess: { goalMet: true },
      }),
      model: stubModel({ text: 'Done.' }),
      tools: { search: searchTool() },
      compaction: { compactor: dropFirstTurnTools, thresholdChars: 0 },
    });
    await tracked.run({ messages });
    expect(seen).toEqual([0]);
  });

  test('a recorded compaction keeps the next view small without compacting again', async () => {
    const messages = await history();
    let calls = 0;
    const counted: Compactor = async (view, context) => {
      calls += 1;
      return dropFirstTurnTools(view, context);
    };
    const first = await agent({ compactor: counted, thresholdChars: 0 }).run({ messages });
    const next = [...first.messages, userMessage('Once more.', 'u3')];
    const threshold = JSON.stringify(compactedView(next)).length + 1;
    // The full history is over the threshold; only the view is under it.
    expect(JSON.stringify(next).length).toBeGreaterThan(threshold);

    await agent({ compactor: counted, thresholdChars: threshold }).run({ messages: next });
    expect(calls).toBe(1);
  });

  test('keeps the view when the compactor fails', async () => {
    const compactor: Compactor = async () => {
      throw new Error('Jev is unavailable');
    };
    const messages = await history();
    const result = await agent({ compactor, thresholdChars: 0 }).run({ messages });

    expect(result.stopReason).toBe('completed');
    const [record] = records(result.messages);
    expect(record).toMatchObject({ outcome: 'failed', detail: 'Compaction failed. Jev is unavailable' });
    expect(compactedView(result.messages).slice(0, 3)).toEqual(messages);
  });

  test('rejects an edit that changes the open turn', async () => {
    const messages = await history();
    const open: AgentMessage = {
      ...messages[1]!,
      parts: messages[1]!.parts.filter(
        part =>
          part.type !== 'data-transition' ||
          (part as { data: { stopReason?: string } }).data.stopReason === undefined,
      ),
    };
    const result = await agent({ compactor: dropFirstTurnTools, thresholdChars: 0 }).run({
      messages: [messages[0]!, open],
    });

    const [record] = records(result.messages);
    expect(record?.outcome).toBe('failed');
    expect(record?.detail).toContain('changed the open turn');
    expect(toolCallIds(compactedView(result.messages)[1])).toHaveLength(1);
  });

  test('rejects a negative threshold', () => {
    const compactor: Compactor = async () => ({});
    expect(() => agent({ compactor, thresholdChars: -1 })).toThrow(ConfigurationError);
  });
});
