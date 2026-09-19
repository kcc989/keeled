import { describe, expect, test } from 'bun:test';
import { createAgent } from '../src/agent.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';
import type { Controller, ReplyReview } from '../src/controller.ts';
import type { RespondAdapter } from '../src/execution.ts';
import type { AgentMessage } from '../src/types.ts';
import { searchTool } from './fixtures.ts';

const markup =
  '<｜DSML｜ calls>\n<｜DSML｜ invoke name="get_user_details">\n<｜DSML｜ parameter name="user_id">u1</｜DSML｜ parameter>';

function drafts(...texts: string[]) {
  const feedback: (string | undefined)[] = [];
  const respond: RespondAdapter = async context => {
    feedback.push(context.feedback);
    return { text: texts[feedback.length - 1] ?? texts.at(-1)! };
  };
  return { respond, feedback };
}

function repairs(messages: AgentMessage[]): string[] {
  return messages
    .flatMap(message => message.parts)
    .filter(part => part.type === 'data-transition')
    .map(part => (part as { data: { kind: string; detail?: string } }).data)
    .filter(transition => transition.kind === 'response-repair')
    .map(transition => transition.detail ?? '');
}

async function reply(respond: RespondAdapter, review?: () => ReplyReview) {
  const base = scriptedController({ decisions: [{ type: 'respond', outcome: 'needs_input' }] });
  const controller: Controller = review === undefined ? base : { ...base, reviewReply: async () => review() };
  const agent = createAgent({
    instructions: 'Help the user.',
    controller,
    model: stubModel(),
    tools: { search: searchTool() },
    respond,
  });
  return agent.run({ messages: [userMessage('Cancel my trip and tell me the refund.')] });
}

const judged = (value: boolean) => ({ value, confidence: 1 });

describe('reply contract', () => {
  test('a reply with tool-call markup is repaired once with the problem as feedback', async () => {
    const { respond, feedback } = drafts(markup, 'Could you share your user id?');
    const result = await reply(respond);
    expect(result.text).toBe('Could you share your user id?');
    expect(feedback[1]).toContain('contained tool-call markup');
    expect(repairs(result.messages)).toHaveLength(1);
  });

  test('markup that survives the repair is replaced by a status response, never sent', async () => {
    const { respond } = drafts(markup, '{"name": "cancel_reservation", "arguments": {"id": "X"}}');
    const result = await reply(respond);
    expect(result.text).not.toContain('DSML');
    expect(result.text).not.toContain('cancel_reservation');
    expect(result.text).toContain('More information is needed');
  });

  test('ordinary replies pass untouched', async () => {
    const { respond, feedback } = drafts('Which reservation should I cancel?');
    const result = await reply(respond);
    expect(result.text).toBe('Which reservation should I cancel?');
    expect(feedback).toEqual([undefined]);
  });
});

describe('reply review', () => {
  test('a reply that misses part of the request is repaired', async () => {
    const { respond, feedback } = drafts('Your trip is cancelled.', 'Your trip is cancelled; the refund is $120.');
    let reviews = 0;
    const result = await reply(respond, () => {
      reviews += 1;
      return { addressesRequest: judged(reviews > 1), supported: judged(true) };
    });
    expect(result.text).toBe('Your trip is cancelled; the refund is $120.');
    expect(feedback[1]).toContain('does not address everything the user asked');
  });

  test('a reply that still falls short on content is sent rather than replaced', async () => {
    const { respond } = drafts('First draft.', 'Second draft.');
    const result = await reply(respond, () => ({ addressesRequest: judged(true), supported: judged(false) }));
    expect(result.text).toBe('Second draft.');
    expect(repairs(result.messages)).toHaveLength(2);
  });
});
