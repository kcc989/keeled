import { describe, expect, test } from 'bun:test';
import { createAgent } from '../src/agent.ts';
import { applyCompactionEdit, compactedView, type CompactionContext } from '../src/compaction.ts';
import { reduceState } from '../src/state.ts';
import { summaryCompactor, summaryPrefix } from '../src/summary.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';
import type { AgentMessage, CompactionRecord } from '../src/types.ts';
import { searchTool } from './fixtures.ts';

type Compaction = Parameters<typeof createAgent>[0]['compaction'];

/** Answers summarization prompts with `summary` and everything else with "Done.". */
function model(summary = 'The user wants the price helper; search found src/index.ts.') {
  const prompts: string[] = [];
  const stub = stubModel({
    text: prompt => {
      if (!prompt.includes('Transcript:')) return 'Done.';
      prompts.push(prompt);
      return summary;
    },
  });
  return { stub, prompts };
}

function agent(stub: ReturnType<typeof stubModel>, compaction?: Compaction) {
  return createAgent({
    instructions: 'Answer the question.',
    controller: scriptedController({
      decisions: [{ type: 'tool', tool: 'search' }, { type: 'respond', outcome: 'completed' }],
      assess: { goalMet: true },
    }),
    model: stub,
    tools: { search: searchTool(['src/index.ts', 'src/pricing.ts']) },
    compaction,
  });
}

/** Two finished turns and a new request: [u1, a1, u2, a2, u3]. */
async function conversation(): Promise<AgentMessage[]> {
  const { stub } = model();
  const first = await agent(stub).run({ messages: [userMessage('Where is the price helper?', 'u1')] });
  const second = await agent(stub).run({
    messages: [...first.messages, userMessage('Rename it to formatPrice.', 'u2')],
  });
  return [...second.messages, userMessage('Now add a test.', 'u3')];
}

function context(text: string, prompts: string[] = []): CompactionContext {
  return {
    abortSignal: new AbortController().signal,
    generateText: async options => {
      prompts.push(options.prompt ?? '');
      return { text, finishReason: 'stop' };
    },
  };
}

function compactionRecord(messages: AgentMessage[]): CompactionRecord | undefined {
  return (messages.at(-1)?.parts ?? [])
    .filter(part => part.type === 'data-compaction')
    .map(part => (part as { data: CompactionRecord }).data)[0];
}

describe('summaryCompactor', () => {
  test('replaces the older messages with a summary in the view', async () => {
    const messages = await conversation();
    const { stub, prompts } = model();
    const result = await agent(stub, {
      compactor: summaryCompactor(),
      thresholdChars: 0,
    }).run({ messages });

    expect(result.stopReason).toBe('completed');
    // The stored history keeps every message.
    expect(result.messages.slice(0, messages.length)).toEqual(messages);
    expect(result.messages).toHaveLength(messages.length + 1);

    const [summary, ...rest] = compactedView(result.messages);
    expect(summary?.role).toBe('assistant');
    expect(summary?.metadata?.summary).toEqual({ replacedMessages: 3 });
    expect((summary?.parts[0] as { text: string }).text).toBe(
      `${summaryPrefix}\n\nThe user wants the price helper; search found src/index.ts.`,
    );
    expect(rest.slice(0, 2)).toEqual([messages[3]!, messages[4]!]);
    expect(rest).toHaveLength(3);

    // The summarizer saw the user's words and the tool evidence, and its usage was counted.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Where is the price helper?');
    expect(prompts[0]).toContain('src/pricing.ts');
    expect(result.usage.model.calls).toBe(2);
    expect(compactionRecord(result.messages)).toMatchObject({
      outcome: 'applied',
      detail: 'Summarized 3 messages.',
      edit: { summary: { firstKeptMessageId: messages[3]!.id } },
    });
  });

  test('keeps the latest request and the open turn intact', async () => {
    const messages = await conversation();
    const interrupted = messages[3]!;
    const open: AgentMessage = {
      ...interrupted,
      parts: interrupted.parts.filter(
        part =>
          part.type !== 'data-transition' ||
          (part as { data: { stopReason?: string } }).data.stopReason === undefined,
      ),
    };
    const history = [...messages.slice(0, 3), open];

    const outcome = await summaryCompactor({ keepRecentMessages: 0 })(history, context('Earlier work.'));
    const view = applyCompactionEdit(history, outcome.edit!, 'cmp');

    expect(view.map(message => message.id)).toEqual(['cmp-summary', 'u2', open.id]);
    expect(view[2]).toBe(open);
    expect(reduceState(view)).toEqual(reduceState(history));
  });

  test('keeps the open turn even with no user request to anchor on', async () => {
    const messages = await conversation();
    const interrupted = messages[3]!;
    const open: AgentMessage = {
      ...interrupted,
      parts: interrupted.parts.filter(
        part =>
          part.type !== 'data-transition' ||
          (part as { data: { stopReason?: string } }).data.stopReason === undefined,
      ),
    };
    const history = [messages[1]!, open];

    const outcome = await summaryCompactor({ keepRecentMessages: 0 })(history, context('Earlier work.'));

    expect(outcome.edit?.summary?.firstKeptMessageId).toBe(open.id);
  });

  test('does nothing when no turn has finished', async () => {
    const prompts: string[] = [];
    const history = [userMessage('Hello', 'u1')];
    const outcome = await summaryCompactor()(history, context('unused', prompts));

    expect(outcome.edit).toBeUndefined();
    expect(prompts).toHaveLength(0);
  });

  test('keeps the full history when the summary is empty', async () => {
    const messages = await conversation();
    const { stub } = model('   ');
    const result = await agent(stub, { compactor: summaryCompactor(), thresholdChars: 0 }).run({
      messages,
    });

    expect(result.stopReason).toBe('completed');
    expect(compactedView(result.messages).slice(0, messages.length)).toEqual(messages);
    expect(compactionRecord(result.messages)).toMatchObject({
      outcome: 'failed',
      detail: 'Compaction failed. The summarizer returned no text.',
    });
  });

  test('leaves out the oldest entries when the transcript is too long', async () => {
    const messages = await conversation();
    const prompts: string[] = [];
    await summaryCompactor({ maxTranscriptChars: 200 })(messages, context('Earlier work.', prompts));

    expect(prompts[0]).toContain('earlier entries left out');
    expect(prompts[0]).not.toContain('Where is the price helper?');
  });
});
