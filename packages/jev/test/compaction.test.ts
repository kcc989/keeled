import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { Questions } from '@typesafe-ai/sdk';
import {
  agentTool,
  compactedView,
  createAgent,
  reduceState,
  type AgentMessage,
  type CompactionRecord,
  type NextAction,
} from '@keeled/core';
import { scriptedController, stubModel, userMessage } from '@keeled/core/testing';
import {
  compactMessages,
  fitState,
  jevCompactor,
  collectToolCalls,
  pinRule,
  type CompactionAsker,
  type CompactionState,
} from '../src/index.ts';

const contents = `export function priceLabel(cents: number) {\n${'  // pricing notes\n'.repeat(120)}}\n`;

const tools = {
  search: agentTool({
    description: 'Search the repository.',
    inputSchema: z.object({ query: z.string() }),
    risk: 'read',
    resolveInput: () => ({ query: 'priceLabel' }),
    execute: ({ query }) => ({ query, files: ['src/pricing.ts', 'src/pricing.test.ts'] }),
  }),
  readFile: agentTool({
    description: 'Read a file.',
    inputSchema: z.object({ path: z.string() }),
    risk: 'read',
    resolveInput: () => ({ path: 'src/pricing.ts' }),
    execute: ({ path }) => ({ path, contents }),
  }),
  lint: agentTool({
    description: 'Run the linter.',
    inputSchema: z.object({}),
    risk: 'read',
    resolveInput: () => ({}),
    execute: () => ({ warnings: Array.from({ length: 40 }, (_, i) => `src/legacy/${i}.ts: unused import`) }),
  }),
};

function agent(decisions: NextAction[], compaction?: Parameters<typeof createAgent>[0]['compaction']) {
  return createAgent({
    instructions: 'Complete the requested change.',
    controller: scriptedController({ decisions, assess: { goalMet: true } }),
    model: stubModel({ text: 'Done.' }),
    tools,
    compaction,
  });
}

const respond: NextAction = { type: 'respond', outcome: 'completed' };
const call = (tool: keyof typeof tools): NextAction => ({ type: 'tool', tool });

/** Two finished turns and a new request: [u1, a1, u2, a2, u3]. */
async function conversation(): Promise<AgentMessage[]> {
  const first = await agent([call('search'), call('readFile'), call('lint'), respond]).run({
    messages: [userMessage('Where is the price helper?', 'u1')],
  });
  const second = await agent([call('search'), respond]).run({
    messages: [...first.messages, userMessage('Rename it to formatPrice.', 'u2')],
  });
  return [...second.messages, userMessage('Now add a test.', 'u3')];
}

/** A fake Jev: answers by tool name and records every request. */
function fakeJev(scores: Record<string, { call: number; result: number }>) {
  const requests: { state: CompactionState; questions: Questions }[] = [];
  const asker: CompactionAsker = {
    async ask(state, questions) {
      requests.push({ state, questions });
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const [name, question] of Object.entries(questions)) {
        const tool = /\((\w+)/.exec(String(question.instructions))?.[1] ?? '';
        const score = scores[tool] ?? { call: 1, result: 1 };
        answers[name] = { type: 'noul', noul: name.startsWith('call_') ? score.call : score.result };
      }
      return { answers, usage: { input_tokens: 100, output_tokens: 2 } };
    },
  };
  return { asker, requests };
}

const scores = {
  search: { call: 0.9, result: 0.8 },
  readFile: { call: 0.7, result: 0.2 },
  lint: { call: 0.1, result: 0.1 },
};

function toolParts(message: AgentMessage | undefined) {
  return (message?.parts ?? []).filter(part => part.type.startsWith('tool-')) as unknown as {
    type: string;
    toolCallId: string;
    output?: unknown;
  }[];
}

describe('compactMessages', () => {
  test('keeps, truncates, or removes each old call as Jev answers', async () => {
    const messages = await conversation();
    const { asker, requests } = fakeJev(scores);
    const result = await compactMessages(messages, { asker });

    expect(requests).toHaveLength(1);
    expect(result.stats).toMatchObject({ calls: 4, kept: 1, resultsDropped: 1, callsDropped: 1, pinned: 1 });
    expect(result.stats.usage).toEqual({ calls: 1, inputTokens: 100, outputTokens: 2 });
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore);

    const parts = toolParts(result.messages[1]);
    expect(parts.map(part => part.type)).toEqual(['tool-search', 'tool-readFile']);
    expect(parts[0]?.output).toEqual(toolParts(messages[1])[0]?.output);
    expect(parts[1]?.output).toBeString();
    expect(parts[1]?.output as string).toContain('[Compacted:');
    expect((parts[1]?.output as string).startsWith('{"path":"src/pricing.ts"')).toBe(true);

    // Untouched messages come back as the same objects, and nothing else is removed.
    for (const index of [0, 2, 3, 4]) expect(result.messages[index]).toBe(messages[index]!);
    const nonTool = (message: AgentMessage | undefined) =>
      (message?.parts ?? []).filter(part => !part.type.startsWith('tool-'));
    expect(nonTool(result.messages[1])).toEqual(nonTool(messages[1]));
  });

  test('the checkpoint copy of each output is compacted the same way', async () => {
    const messages = await conversation();
    const result = await compactMessages(messages, { asker: fakeJev(scores).asker });
    const observations = result.messages[1]?.metadata?.checkpoint?.state.observations ?? [];
    const [search, readFile, lint] = toolParts(messages[1]).map(part =>
      observations.find(observation => observation.id === part.toolCallId),
    );

    expect(search?.detail).toEqual(toolParts(messages[1])[0]?.output);
    expect(readFile?.detail as string).toContain('[Compacted:');
    expect(lint).toBeDefined();
    expect(lint?.detail).toBeUndefined();
  });

  test('replaying the compacted history reduces to the same state', async () => {
    const messages = await conversation();
    const result = await compactMessages(messages, { asker: fakeJev(scores).asker });
    expect(reduceState(result.messages)).toEqual(reduceState(messages));

    const next = await agent([call('search'), respond]).run({ messages: result.messages });
    expect(next.stopReason).toBe('completed');
  });

  test('the open turn is never a candidate', async () => {
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
    const { asker, requests } = fakeJev({ search: { call: 0, result: 0 } });

    const result = await compactMessages(history, { asker, preserveRecentMessages: 0 });

    const asked = Object.keys(requests[0]?.questions ?? {});
    expect(asked).toEqual(['call_t1', 'result_t1', 'call_t2', 'result_t2', 'call_t3', 'result_t3']);
    expect(result.messages[3]).toBe(open);
    expect(reduceState(result.messages)).toEqual(reduceState(history));
  });

  test('makes no request when every call is pinned', async () => {
    const messages = await conversation();
    const { asker, requests } = fakeJev(scores);
    const result = await compactMessages(messages, { asker, preserveRecentMessages: 10 });

    expect(requests).toHaveLength(0);
    expect(result.stats.requests).toBe(0);
    result.messages.forEach((message, index) => expect(message).toBe(messages[index]!));
  });

  test('splits questions into several requests that share the full state', async () => {
    const messages = await conversation();
    const probe = await compactMessages(messages, { asker: fakeJev(scores).asker });
    const { asker, requests } = fakeJev(scores);

    const result = await compactMessages(messages, {
      asker,
      maxRequestTokens: probe.stats.stateTokens + 20 + 150,
    });

    expect(requests).toHaveLength(3);
    expect(new Set(requests.map(request => JSON.stringify(request.state))).size).toBe(1);
    expect(result.decisions.map(decision => decision.reason)).toEqual(
      probe.decisions.map(decision => decision.reason),
    );
  });

  test('shrinks the state in stages, and throws when it cannot fit', async () => {
    const messages = await conversation();
    const pinned = pinRule(messages, 2);
    const calls = collectToolCalls(messages, pinned);
    const full = fitState(messages, calls, { maxStateTokens: 25_000, goal: '', pinned });

    expect(full.stage).toBe('full');
    expect(full.state.goal).toContain('Now add a test.');
    expect(JSON.stringify(full.state)).not.toContain('pricing notes');

    const smaller = fitState(messages, calls, { maxStateTokens: full.tokens - 20, goal: '', pinned });
    expect(smaller.stage).not.toBe('full');
    expect(smaller.tokens).toBeLessThanOrEqual(full.tokens - 20);

    expect(() => fitState(messages, calls, { maxStateTokens: 10, goal: '', pinned })).toThrow(
      /too large/,
    );
  });

  test('a malformed Jev answer fails the compaction', async () => {
    const messages = await conversation();
    const asker: CompactionAsker = { ask: async () => ({ answers: {} }) };
    await expect(compactMessages(messages, { asker })).rejects.toThrow(/Invalid Jev answer/);
  });
});

describe('jevCompactor', () => {
  test('compacts the history before a turn when switched on', async () => {
    const messages = await conversation();
    const { asker, requests } = fakeJev(scores);
    const result = await agent([call('search'), respond], {
      compactor: jevCompactor({ asker }),
      thresholdChars: 0,
    }).run({ messages });

    expect(requests).toHaveLength(1);
    expect(result.stopReason).toBe('completed');
    expect(result.usage.controller.inputTokens).toBe(100);

    // Stored history is untouched; the view applies Jev's decisions.
    expect(result.messages.slice(0, messages.length)).toEqual(messages);
    const view = compactedView(result.messages);
    expect(toolParts(view[1]).map(part => part.type)).toEqual(['tool-search', 'tool-readFile']);
    expect(toolParts(view[1])[1]?.output as string).toContain('[Compacted:');

    const record = (result.messages.at(-1)?.parts ?? [])
      .filter(part => part.type === 'data-compaction')
      .map(part => (part as { data: CompactionRecord }).data)[0];
    expect(record?.outcome).toBe('applied');
    expect(record?.detail).toBe('Jev kept 1, truncated 1, and removed 1 tool calls.');
  });

  test('proposes no edit when the reduction is too small', async () => {
    const messages = await conversation();
    const compactor = jevCompactor({ asker: fakeJev(scores).asker, minReduction: 0.99 });
    const outcome = await compactor(messages, {
      abortSignal: new AbortController().signal,
      generateText: async () => ({ text: '', finishReason: 'stop' }),
    });

    expect(outcome.edit).toBeUndefined();
    expect(outcome.detail).toContain('under the minimum');
  });
});
