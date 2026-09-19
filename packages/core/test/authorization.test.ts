import { describe, expect, setSystemTime, test } from 'bun:test';
import { z } from 'zod';
import { createTestAgent as createAgent } from './fixtures.ts';
import { agentTool } from '../src/tool.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';
import type { PendingAction } from '../src/controller.ts';
import { MissingInformation } from '../src/errors.ts';
import type { AgentMessage } from '../src/types.ts';

function tools() {
  const executed: unknown[] = [];
  const cancel = agentTool({
    description: 'Cancel a document.',
    inputSchema: z.object({ document_id: z.string() }),
    risk: 'write',
    resolveInput: () => ({ document_id: 'Q69X3R' }),
    execute: input => {
      executed.push(input);
      return { status: 'cancelled' };
    },
  });
  const lookup = agentTool({
    description: 'Look up a document.',
    inputSchema: z.object({}),
    risk: 'read',
    resolveInput: () => ({}),
    execute: () => ({ created_at: '2024-05-14T09:52:38' }),
  });
  return { executed, tools: { cancel, lookup } };
}

function transitions(messages: AgentMessage[]): { kind: string; detail?: string }[] {
  return messages
    .flatMap(message => message.parts)
    .filter(part => part.type === 'data-transition')
    .map(part => (part as { data: { kind: string; detail?: string } }).data);
}

async function run(
  authorize: (action: PendingAction) => { permitted: boolean; needsVerification?: boolean; confirmed: boolean },
  verdict?: { permitted: boolean; reason: string },
) {
  const { executed, tools: registered } = tools();
  const asked: PendingAction[] = [];
  const agent = createAgent({
    instructions: 'Cancel only within 24 hours of creation. Confirm writes with the user first.',
    controller: scriptedController({
      decisions: [
        { type: 'tool', tool: 'lookup' },
        { type: 'tool', tool: 'cancel' },
        { type: 'respond', outcome: 'needs_input' },
      ],
      authorize: action => {
        asked.push(action);
        return authorize(action);
      },
    }),
    model: stubModel({ text: 'Reply.', objects: verdict === undefined ? [] : [verdict] }),
    tools: registered,
  });
  const result = await agent.run({ messages: [userMessage('Cancel my trip.')] });
  return { result, executed, asked };
}

describe('authorization before a write', () => {
  test('a permitted, confirmed write runs and is recorded as authorized', async () => {
    const { result, executed, asked } = await run(() => ({ permitted: true, confirmed: true }));
    expect(executed).toEqual([{ document_id: 'Q69X3R' }]);
    expect(asked.map(action => [action.tool, action.input])).toEqual([['cancel', { document_id: 'Q69X3R' }]]);
    expect(transitions(result.messages).find(t => t.kind === 'authorized')?.detail).toContain('(controller)');
  });

  test('an unconfirmed write does not run and asks for confirmation', async () => {
    const { result, executed } = await run(() => ({ permitted: true, confirmed: false }));
    expect(executed).toEqual([]);
    expect(result.state.blockers.at(-1)).toMatchObject({ kind: 'needs_confirmation', tool: 'cancel' });
    expect(result.state.blockers.at(-1)?.resolution).toContain('ask them to confirm');
  });

  test('when verification is needed, the model decides and can refuse', async () => {
    const { result, executed } = await run(
      () => ({ permitted: true, needsVerification: true, confirmed: true }),
      { permitted: false, reason: 'It was created more than 24 hours ago.' },
    );
    expect(executed).toEqual([]);
    expect(result.state.blockers.at(-1)).toMatchObject({
      kind: 'policy_denied',
      reason: 'Not permitted: cancel {"document_id":"Q69X3R"}. It was created more than 24 hours ago.',
      input: { document_id: 'Q69X3R' },
    });
  });

  test('when the controller doubts it, a model verdict of permitted lets it run', async () => {
    const { result, executed } = await run(
      () => ({ permitted: false, confirmed: true }),
      { permitted: true, reason: 'It is a premium class creation.' },
    );
    expect(executed).toHaveLength(1);
    expect(transitions(result.messages).find(t => t.kind === 'authorized')?.detail).toContain(
      'verified: It is a premium class creation.',
    );
  });

  test('a weak yes escalates, unless the policy lowers the floor', async () => {
    async function attempt(permittedFloor?: number) {
      const { executed, tools: registered } = tools();
      const base = scriptedController({
        decisions: [
          { type: 'tool', tool: 'cancel' },
          { type: 'respond', outcome: 'needs_input' },
        ],
      });
      const agent = createAgent({
        instructions: 'Cancel only within 24 hours of creation.',
        controller: {
          ...base,
          async authorize() {
            return {
              permitted: { value: true, confidence: 0.2 },
              needsVerification: { value: false, confidence: 0.9 },
              confirmed: { value: true, confidence: 0.9 },
            };
          },
        },
        model: stubModel({ text: 'Reply.', objects: [{ permitted: false, reason: 'Booked 29 hours ago.' }] }),
        tools: registered,
        ...(permittedFloor === undefined ? {} : { policy: { authorization: { permittedFloor } } }),
      });
      await agent.run({ messages: [userMessage('Cancel my trip.')] });
      return executed.length;
    }
    expect(await attempt()).toBe(0);
    expect(await attempt(0.1)).toBe(1);
  });

  test('a doubtful confirmation counts as none', async () => {
    const { executed, tools: registered } = tools();
    const base = scriptedController({
      decisions: [
        { type: 'tool', tool: 'cancel' },
        { type: 'respond', outcome: 'needs_input' },
      ],
    });
    const agent = createAgent({
      instructions: 'Confirm writes with the user first.',
      controller: {
        ...base,
        async authorize() {
          return {
            permitted: { value: true, confidence: 0.9 },
            needsVerification: { value: false, confidence: 0.9 },
            confirmed: { value: true, confidence: 0.3 },
          };
        },
      },
      model: stubModel({ text: 'Please confirm.' }),
      tools: registered,
    });
    const result = await agent.run({ messages: [userMessage('Cancel my trip.')] });
    expect(executed).toEqual([]);
    expect(result.state.blockers.at(-1)?.reason).toContain("Awaiting the user's explicit confirmation");
  });

  test('unknown-risk tools are authorized by default', async () => {
    const asked: string[] = [];
    const transfer = agentTool({
      description: 'Transfer to a human.',
      inputSchema: z.object({}),
      resolveInput: () => ({}),
      execute: () => 'Transfer successful',
    });
    const agent = createAgent({
      instructions: 'Transfer when asked.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'transfer' },
          { type: 'respond', outcome: 'completed' },
        ],

        authorize: action => {
          asked.push(action.tool);
          return { permitted: true, confirmed: true };
        },
      }),
      model: stubModel({ text: 'Transferred.' }),
      tools: { transfer },
    });
    await agent.run({ messages: [userMessage('Get me a human.')] });
    expect(asked).toEqual(['transfer']);
  });

  test('read tools are never sent for authorization', async () => {
    const { asked } = await run(() => ({ permitted: true, confirmed: true }));
    expect(asked.every(action => action.tool !== 'lookup')).toBe(true);
  });

  test('a refused call retried with the same input is refused again without asking', async () => {
    const { executed, tools: registered } = tools();
    let asked = 0;
    const agent = createAgent({
      instructions: 'Cancel only within 24 hours of creation.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'cancel' },
          { type: 'tool', tool: 'cancel' },
          { type: 'tool', tool: 'cancel' },
          { type: 'respond', outcome: 'blocked' },
        ],
        authorize: () => {
          asked += 1;
          return { permitted: false, confirmed: true };
        },
      }),
      // One verdict only: a second model check would get an empty verdict and a different reason.
      model: stubModel({ text: 'Reply.', objects: [{ permitted: false, reason: 'Booked 29 hours ago.' }] }),
      tools: registered,
    });
    const result = await agent.run({ messages: [userMessage('Cancel my trip.')] });
    expect(executed).toEqual([]);
    expect(asked).toBe(1);
    // A refusal is not new evidence, so the third identical attempt is reported as no progress.
    expect(result.state.blockers.map(blocker => blocker.kind)).toEqual([
      'policy_denied',
      'policy_denied',
      'policy_denied',
      'no_progress',
    ]);
    expect(result.stopReason).toBe('blocked');
  });

  test('new evidence after a refusal for missing evidence gets the call judged again', async () => {
    const { tools: registered } = tools();
    let asked = 0;
    const agent = createAgent({
      instructions: 'Cancel only within 24 hours of creation.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'cancel' },
          { type: 'tool', tool: 'lookup' },
          { type: 'tool', tool: 'cancel' },
          { type: 'respond', outcome: 'blocked' },
        ],
        authorize: () => {
          asked += 1;
          return { permitted: false, confirmed: true };
        },
      }),
      model: stubModel({
        text: 'Reply.',
        objects: [
          { permitted: false, reason: 'The creation time is unknown.', missing: 'the document creation time' },
          { permitted: false, reason: 'Booked 29 hours ago.', missing: '' },
        ],
      }),
      tools: registered,
    });
    const result = await agent.run({ messages: [userMessage('Cancel my trip.')] });
    expect(asked).toBe(2);
    expect(result.state.blockers.map(blocker => [blocker.kind, blocker.resolution])).toEqual([
      ['missing_evidence', 'Obtain this evidence first: the document creation time'],
      ['policy_denied', 'Do not retry this action; explain the refusal to the user or choose one the policy permits.'],
    ]);
  });

  test('a call awaiting confirmation leaves only the other tools available this turn', async () => {
    const { tools: registered } = tools();
    const available: string[][] = [];
    const agent = createAgent({
      instructions: 'Confirm writes with the user first.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'cancel' },
          context => {
            available.push(context.availableTools.map(tool => tool.name));
            return { type: 'respond', outcome: 'needs_input' };
          },
        ],
        authorize: () => ({ permitted: true, confirmed: false }),
      }),
      model: stubModel({ text: 'Shall I cancel it?' }),
      tools: registered,
    });
    await agent.run({ messages: [userMessage('Cancel my trip.')] });
    expect(available).toEqual([['lookup']]);
  });
});

describe('exact repeats', () => {
  function counting(risk: 'read' | 'write', repeat: 'allow' | 'reuse' = 'reuse') {
    let calls = 0;
    const tool = agentTool({
      description: 'Search items.',
      inputSchema: z.object({ route: z.string() }),
      risk,
      repeat,
      resolveInput: () => ({ route: 'SEA-HQ1' }),
      execute: () => {
        calls += 1;
        return { items: ['SKU021'] };
      },
    });
    return { tool, count: () => calls };
  }

  test('by default every call runs, however often it repeats', async () => {
    const poll = counting('read', 'allow');
    const agent = createAgent({
      instructions: 'Poll until ready.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'poll' },
          { type: 'tool', tool: 'poll' },
          { type: 'respond', outcome: 'completed' },
        ],

      }),
      model: stubModel({ text: 'Ready.' }),
      tools: { poll: poll.tool },
    });
    const result = await agent.run({ messages: [userMessage('Is it ready?')] });
    expect(poll.count()).toBe(2);
    expect(result.state.blockers).toHaveLength(0);
  });

  test('a reusable lookup that already returned for the same input is not run again', async () => {
    const search = counting('read');
    const agent = createAgent({
      instructions: 'Find items.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'search' },
          { type: 'tool', tool: 'search' },
          { type: 'respond', outcome: 'completed' },
        ],

      }),
      model: stubModel({ text: 'Here are the items.' }),
      tools: { search: search.tool },
    });
    const result = await agent.run({ messages: [userMessage('Items in warehouse A?')] });
    expect(search.count()).toBe(1);
    expect(result.state.blockers.at(-1)?.reason).toContain('already returned a result this turn for this exact input');
    expect(result.stopReason).toBe('completed');
  });

  test('a lookup may repeat after an action that could change its result', async () => {
    const search = counting('read');
    const change = counting('write');
    const agent = createAgent({
      instructions: 'Find items.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'search' },
          { type: 'tool', tool: 'change' },
          { type: 'tool', tool: 'search' },
          { type: 'respond', outcome: 'completed' },
        ],

      }),
      model: stubModel({ text: 'Done.' }),
      tools: { search: search.tool, change: change.tool },
    });
    await agent.run({ messages: [userMessage('Change my item.')] });
    expect(search.count()).toBe(2);
  });
});

describe('what a refusal depends on', () => {
  function counter() {
    const executed: unknown[] = [];
    const seen: { objective?: string; evidence?: string[]; awaitingInput?: unknown }[] = [];
    const cancel = agentTool({
      description: 'Cancel a document.',
      inputSchema: z.object({ document_id: z.string() }),
      risk: 'write',
      resolveInput: context => {
        seen.push({ ...context.action });
        return { document_id: 'Q69X3R' };
      },
      execute: input => {
        executed.push(input);
        return { status: 'cancelled' };
      },
    });
    const lookup = agentTool({
      description: 'Look up item status.',
      inputSchema: z.object({}),
      risk: 'read',
      resolveInput: () => ({}),
      execute: () => ({ status: 'on time' }),
    });
    const change = agentTool({
      description: 'Change the document.',
      inputSchema: z.object({}),
      risk: 'write',
      resolveInput: () => ({}),
      execute: () => ({ changed: true }),
    });
    return { executed, seen, tools: { cancel, lookup, change } };
  }

  async function refusals(decisions: Parameters<typeof scriptedController>[0]['decisions'], verdicts: object[]) {
    const { tools: registered } = counter();
    let asked = 0;
    const agent = createAgent({
      instructions: 'Cancel only within 24 hours of creation.',
      controller: scriptedController({
        decisions: [...decisions, { type: 'respond', outcome: 'blocked' }],
        authorize: action => {
          if (action.tool === 'cancel') asked += 1;
          return { permitted: action.tool !== 'cancel', confirmed: true };
        },
      }),
      model: stubModel({ text: 'Reply.', objects: verdicts }),
      tools: registered,
    });
    await agent.run({ messages: [userMessage('Cancel my trip.')] });
    return asked;
  }

  const denied = { permitted: false, reason: 'Booked 29 hours ago.', missing: '', evidence: [], timeSensitive: false };

  test('an unrelated lookup does not reopen a refusal', async () => {
    const asked = await refusals(
      [{ type: 'tool', tool: 'cancel' }, { type: 'tool', tool: 'lookup' }, { type: 'tool', tool: 'cancel' }],
      [denied],
    );
    expect(asked).toBe(1);
  });

  test('a successful state-changing call reopens it', async () => {
    const asked = await refusals(
      [{ type: 'tool', tool: 'cancel' }, { type: 'tool', tool: 'change' }, { type: 'tool', tool: 'cancel' }],
      [denied, denied],
    );
    expect(asked).toBe(2);
  });

  test('a time-dependent refusal lapses', async () => {
    const { tools: registered } = counter();
    let asked = 0;
    const agent = createAgent({
      instructions: 'Cancel only within 24 hours of creation.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'cancel' },
          () => {
            setSystemTime(new Date(Date.now() + 120_000));
            return { type: 'tool', tool: 'cancel' };
          },
          { type: 'respond', outcome: 'blocked' },
        ],
        authorize: () => {
          asked += 1;
          return { permitted: false, confirmed: true };
        },
      }),
      model: stubModel({ text: 'Reply.', objects: [{ ...denied, timeSensitive: true }, denied] }),
      tools: registered,
    });
    try {
      await agent.run({ messages: [userMessage('Cancel my trip.')] });
    } finally {
      setSystemTime();
    }
    expect(asked).toBe(2);
  });
});

describe('an action held for confirmation', () => {
  test('resumes its exact input on the next turn before asking the controller to select it again', async () => {
    const executed: unknown[] = [];
    const awaiting: unknown[] = [];
    let turn = 1;
    let authorizations = 0;
    const cancel = agentTool({
      description: 'Cancel a document.',
      inputSchema: z.object({ document_id: z.string() }),
      risk: 'write',
      resolveInput: context => {
        awaiting.push(context.action?.awaitingInput);
        return (context.action?.awaitingInput as { document_id: string } | undefined) ?? { document_id: 'Q69X3R' };
      },
      execute: input => {
        executed.push(input);
        return { status: 'cancelled' };
      },
    });
    const agent = createAgent({
      instructions: 'Confirm cancellations with the user first.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'cancel' },
          { type: 'respond', outcome: 'needs_input' },
          { type: 'respond', outcome: 'completed' },
        ],

        authorize: () => {
          authorizations += 1;
          return { permitted: true, confirmed: turn === 2 };
        },
      }),
      model: stubModel({ text: 'Reply.' }),
      tools: { cancel },
    });

    const first = await agent.run({ messages: [userMessage('Cancel Q69X3R.')] });
    expect(executed).toEqual([]);
    turn = 2;
    await agent.run({ messages: [...first.messages, userMessage('Yes, cancel it.', 'user-2')] });

    expect(awaiting).toEqual([undefined]);
    expect(authorizations).toBe(2);
    expect(executed).toEqual([{ document_id: 'Q69X3R' }]);
  });
});

describe('the selected action reaches input resolution', () => {
  test('a resolver receives the selected tool and may report missing information', async () => {
    const seen: unknown[] = [];
    const search = agentTool({
      description: 'Search items.',
      inputSchema: z.object({ route: z.string() }),
      risk: 'read',
      resolveInput: context => {
        seen.push(context.action);
        throw new MissingInformation('the return date, from the user');
      },
      execute: () => [],
    });
    const agent = createAgent({
      instructions: 'Book trips.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'search' },
          { type: 'respond', outcome: 'needs_input' },
        ],
      }),
      model: stubModel({ text: 'When do you return?' }),
      tools: { search },
    });
    const result = await agent.run({ messages: [userMessage('Book a round trip.')] });
    expect(seen).toEqual([{ tool: 'search' }]);
    expect(result.state.blockers).toMatchObject([
      { kind: 'missing_evidence', tool: 'search', resolution: 'Obtain it first, from a lookup or from the user: the return date, from the user' },
    ]);
  });
});
