import { expect, test } from 'bun:test';
import { z } from 'zod';
import { jsonSchema } from 'ai';
import { createAgent } from '../src/agent.ts';
import { agentTool } from '../src/tool.ts';
import { MissingInformation } from '../src/errors.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';

for (const name of ['find_document', 'inspect_sensor']) {
  test(`recovery changes a stalled tool to ${name}`, async () => {
    let called = 0;

    const agent = createAgent({
      instructions: 'Use evidence to complete the request.',
      model: stubModel(),
      recovery: { model: stubModel({ objects: [{ type: 'call', tool: name, input: { query: 'supplied' } }] }) },
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'stuck' },
          { type: 'respond', outcome: 'blocked' },
          { type: 'respond', outcome: 'completed' },
        ],
      }),
      tools: {
        stuck: agentTool({
          description: 'Needs a lookup first.',
          risk: 'read',
          inputSchema: z.object({}),
          resolveInput: () => {
            throw new MissingInformation('Find the identifier.');
          },
          execute: () => null,
        }),
        [name]: agentTool({
          description: 'Obtain the missing identifier.',
          risk: 'read',
          inputSchema: z.object({ query: z.string() }),
          execute: () => {
            called++;

            return { id: 'found' };
          },
        }),
      },
    });

    const result = await agent.run({ messages: [userMessage('supplied')] });
    expect(called).toBe(1);
    expect(result.stopReason).toBe('completed');
    expect(result.state.recoveryRevisions).toHaveLength(1);
    expect(result.steps).toBe(5);
  });
}

for (const mode of ['invalid', 'denied', 'unknown', 'unavailable'] as const) {
  test(`recovery cannot bypass ${mode} checks`, async () => {
    let writes = 0;

    const agent = createAgent({
      instructions: 'Only authorized writes are permitted.',
      model: stubModel(),
      recovery: {
        model: stubModel({
          objects: [{ type: 'call', tool: 'save', input: mode === 'invalid' ? {} : { value: 'x' } }],
        }),
      },
      controller: scriptedController({
        decisions: mode === 'unknown' ? [{ type: 'tool', tool: 'save' }] : [],
        authorize: () => ({ permitted: mode !== 'denied', confirmed: true }),
      }),
      tools: {
        save: agentTool({
          description: 'Save a value.',
          risk: 'write',
          inputSchema: z.object({ value: z.string() }),
          available: () => mode !== 'unavailable',
          resolveInput: () => ({ value: 'x' }),
          execute: () => {
            writes++;
            throw new Error('Transport lost');
          },
        }),
      },
    });

    const result = await agent.run({ messages: [userMessage('Save x')] });
    expect(writes).toBe(mode === 'unknown' ? 1 : 0);
    expect(result.stopReason).toBe('blocked');
  });
}

test('unrelated observations and repeated user request do not reopen recovery', async () => {
  let calls = 0;

  const agent = createAgent({
    instructions: 'Read values.',
    model: stubModel(),
    recovery: { model: stubModel({ objects: [{ type: 'call', tool: 'read', input: {} }] }) },
    onGeneration: (trace) => {
      if (trace.purpose === 'stall_recovery') calls++;
    },
    controller: scriptedController({ decisions: [] }),
    tools: {
      read: agentTool({
        description: 'Read a changing value.',
        risk: 'read',
        inputSchema: z.object({}),
        execute: () => Math.random(),
      }),
    },
  });

  const first = await agent.run({ messages: [userMessage('Read')] });
  await agent.run({ messages: [...first.messages, userMessage('Read')] });
  expect(calls).toBe(1);
});

test('normal discovery and input requests do not invoke recovery', async () => {
  let calls = 0;

  const agent = createAgent({
    instructions: 'Ask what is needed.',
    model: stubModel(),
    tools: { read: agentTool({ description: 'Read.', risk: 'read', inputSchema: z.object({}), execute: () => null }) },
    recovery: { model: stubModel() },
    onGeneration: (trace) => {
      if (trace.purpose === 'stall_recovery') calls++;
    },
    controller: scriptedController({ decisions: [{ type: 'respond', outcome: 'needs_input' }] }),
  });

  expect((await agent.run({ messages: [userMessage('Help')] })).stopReason).toBe('needs_input');
  expect(calls).toBe(0);
});

test('existing loop guard recovers a repeated wrong choice once', async () => {
  let repaired = 0;
  let calls = 0;

  const agent = createAgent({
    instructions: 'Inspect the fault.',
    model: stubModel(),
    recovery: { model: stubModel({ objects: [{ type: 'call', tool: 'diagnose', input: {} }] }) },
    onGeneration: (trace) => {
      if (trace.purpose === 'stall_recovery') calls++;
    },
    controller: scriptedController({ decisions: [], fallback: { type: 'tool', tool: 'ping' } }),
    tools: {
      ping: agentTool({
        description: 'Ping.',
        risk: 'read',
        inputSchema: z.object({}),
        resolveInput: () => ({}),
        execute: () => 'unchanged',
      }),
      diagnose: agentTool({
        description: 'Inspect fault.',
        risk: 'read',
        inputSchema: z.object({}),
        execute: () => {
          repaired++;

          return 'fault found';
        },
      }),
    },
  });

  const result = await agent.run({ messages: [userMessage('Inspect the fault')] });
  expect(repaired).toBe(1);
  expect(calls).toBe(1);
  expect(result.stopReason).toBe('blocked');
});

for (const type of ['needs_input', 'blocked'] as const) {
  test(`recovery can return ${type} for unavailable information`, async () => {
    const agent = createAgent({
      instructions: 'Read a private document.',
      model: stubModel(),
      recovery: {
        model: stubModel({
          objects: [
            type === 'needs_input' ? { type, question: 'What is the access code?' } : { type, reason: 'No access.' },
          ],
        }),
      },
      controller: scriptedController({ decisions: [] }),
      tools: {
        read: agentTool({ description: 'Read.', risk: 'read', inputSchema: z.object({}), execute: () => null }),
      },
    });

    expect((await agent.run({ messages: [userMessage('Read it')] })).stopReason).toBe(type);
  });
}

test('recovery retries a transient read through the ordinary path', async () => {
  let reads = 0;

  const agent = createAgent({
    instructions: 'Read status.',
    model: stubModel(),
    recovery: { model: stubModel({ objects: [{ type: 'call', tool: 'status', input: {} }] }) },
    controller: scriptedController({
      decisions: [
        { type: 'tool', tool: 'status' },
        { type: 'respond', outcome: 'blocked' },
        { type: 'respond', outcome: 'completed' },
      ],
    }),
    tools: {
      status: agentTool({
        description: 'Read status.',
        risk: 'read',
        inputSchema: z.object({}),
        resolveInput: () => ({}),
        execute: () => {
          if (++reads === 1) throw new Error('Temporary failure');

          return 'ready';
        },
      }),
    },
  });

  expect((await agent.run({ messages: [userMessage('Read status')] })).stopReason).toBe('completed');
  expect(reads).toBe(2);
});

test('recovery spends a step even when there is no budget to execute its proposal', async () => {
  let executed = 0;

  const agent = createAgent({
    instructions: 'Read.',
    model: stubModel(),
    policy: { maxSteps: 2 },
    recovery: { model: stubModel({ objects: [{ type: 'call', tool: 'read', input: {} }] }) },
    controller: scriptedController({ decisions: [] }),
    tools: {
      read: agentTool({
        description: 'Read.',
        risk: 'read',
        inputSchema: z.object({}),
        execute: () => {
          executed++;

          return null;
        },
      }),
    },
  });

  const result = await agent.run({ messages: [userMessage('Read')] });
  expect(executed).toBe(0);
  expect(result.steps).toBe(2);
});

test('recovery cannot supply user confirmation', async () => {
  let writes = 0;

  const agent = createAgent({
    instructions: 'Require explicit confirmation.',
    model: stubModel(),
    recovery: { model: stubModel({ objects: [{ type: 'call', tool: 'publish', input: {} }] }) },
    controller: scriptedController({ decisions: [], authorize: () => ({ permitted: true, confirmed: false }) }),
    tools: {
      publish: agentTool({
        description: 'Publish.',
        risk: 'write',
        inputSchema: z.object({}),
        execute: () => {
          writes++;

          return null;
        },
      }),
    },
  });

  const result = await agent.run({ messages: [userMessage('Prepare publication')] });
  expect(writes).toBe(0);
  expect(result.state.blockers.at(-1)?.kind).toBe('needs_confirmation');
});

test('invalid recovery output consumes its persisted allowance', async () => {
  let attempts = 0;

  const agent = createAgent({
    instructions: 'Read.',
    model: stubModel(),
    recovery: { model: stubModel({ objects: [{ type: 'plan', steps: [] }] }) },
    onGeneration: (trace) => {
      if (trace.purpose === 'stall_recovery') attempts++;
    },
    controller: scriptedController({ decisions: [] }),
    tools: { read: agentTool({ description: 'Read.', risk: 'read', inputSchema: z.object({}), execute: () => null }) },
  });

  const first = await agent.run({ messages: [userMessage('Read')] });
  expect(first.stopReason).toBe('blocked');
  expect(first.steps).toBe(2);
  expect(first.state.recoveryRevisions).toHaveLength(1);
  await agent.run({ messages: [...first.messages, userMessage('Read')] });
  expect(attempts).toBe(1);
});

for (const input of [null, {}, { code: 3 }, { code: 'ok', extra: true }]) {
  test(`plain JSON Schema rejects malformed recovery input ${JSON.stringify(input)}`, async () => {
    let executions = 0;

    const agent = createAgent({
      instructions: 'Inspect.',
      model: stubModel(),
      recovery: { model: stubModel({ objects: [{ type: 'call', tool: 'inspect', input }] }) },
      controller: scriptedController({ decisions: [] }),
      tools: {
        inspect: agentTool({
          description: 'Inspect a code.',
          risk: 'read',
          inputSchema: jsonSchema({
            type: 'object',
            properties: { code: { type: 'string' } },
            required: ['code'],
            additionalProperties: false,
          }),
          execute: () => {
            executions++;

            return null;
          },
        }),
      },
    });

    const result = await agent.run({ messages: [userMessage('Inspect')] });
    expect(executions).toBe(0);
    expect(result.state.blockers.at(-1)?.kind).toBe('invalid_input');
  });
}

test('Zod refinements and transforms remain active for recovery calls', async () => {
  const received: string[] = [];

  const agent = createAgent({
    instructions: 'Inspect labels.',
    model: stubModel(),
    recovery: { model: stubModel({ objects: [{ type: 'call', tool: 'label', input: { name: '  valid  ' } }] }) },
    controller: scriptedController({ decisions: [] }),
    tools: {
      label: agentTool({
        description: 'Inspect a label.',
        risk: 'read',
        inputSchema: z.object({
          name: z
            .string()
            .trim()
            .refine((name) => name.length >= 4),
        }),
        execute: ({ name }) => {
          received.push(name);

          return null;
        },
      }),
    },
  });

  await agent.run({ messages: [userMessage('Inspect valid')] });
  expect(received).toEqual(['valid']);
});

test('JSON Schema conditional constraints are validated without conversion to Zod', async () => {
  let executions = 0;

  const agent = createAgent({
    instructions: 'Inspect storage.',
    model: stubModel(),
    recovery: { model: stubModel({ objects: [{ type: 'call', tool: 'inspect', input: { kind: 'remote' } }] }) },
    controller: scriptedController({ decisions: [] }),
    tools: {
      inspect: agentTool({
        description: 'Inspect storage.',
        risk: 'read',
        inputSchema: jsonSchema({
          type: 'object',
          properties: { kind: { type: 'string' }, address: { type: 'string' } },
          if: { properties: { kind: { const: 'remote' } } },
          // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema uses the literal keyword then.
          then: { required: ['address'] },
        }),
        execute: () => {
          executions++;

          return null;
        },
      }),
    },
  });

  const result = await agent.run({ messages: [userMessage('Inspect remote storage')] });
  expect(executions).toBe(0);
  expect(result.state.blockers.at(-1)?.kind).toBe('invalid_input');
});
