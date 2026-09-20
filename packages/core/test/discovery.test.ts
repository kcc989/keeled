import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createAgent } from '../src/agent.ts';
import { agentTool } from '../src/tool.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';
import { stableHash } from '../src/ids.ts';
import { discoveryValue, type DiscoveryEvaluation } from '../src/discovery.ts';

async function run(
  options: {
    names?: [string, string, string];
    enabled?: boolean;
    failCheck?: boolean;
    values?: (string | number)[];
    mode?: 'any' | 'unique' | 'all';
    maxCalls?: number;
    verdict?: DiscoveryEvaluation['verdict'];
    deny?: boolean;
    fail?: boolean;
    wrongTool?: boolean;
    wrongPath?: boolean;
    unavailable?: boolean;
    transform?: boolean;
    maxSteps?: number;
  } = {},
) {
  const [list, lookup, field] = options.names ?? ['list_documents', 'open_document', 'document_key'];
  const values = options.values ?? ['doc-a', 'doc-b'];
  const executions: unknown[] = [];
  const traces: string[] = [];

  const controller = scriptedController({
    decisions: [
      { type: 'tool_call', tool: list, input: {} },
      { type: 'respond', outcome: 'completed' },
    ],
    authorize: (action) => ({ permitted: !options.deny || action.tool === list, confirmed: true }),
  });

  const checks: unknown[] = [];

  const model = stubModel({
    objects: [
      {
        use: true,
        source: stableHash([list, {}, ['refs'], values]),
        tool: options.wrongTool ? 'erase' : lookup,
        inputField: field,
        valuePath: options.wrongPath ? ['missing'] : [],
        objective: 'Find the requested record',
        constraints: [],
        mode: options.mode ?? 'unique',
      },
      { permitted: false, reason: 'Restricted read', missing: '', evidence: [], timeSensitive: false },
    ],
    text: 'Done.',
  });

  const result = await createAgent({
    instructions: 'Inspect the referenced records. Do not erase anything.',
    discovery: { enabled: options.enabled ?? true, maxCalls: options.maxCalls ?? 8 },
    controller: {
      ...controller,
      evaluateDiscovery: async (question) => {
        checks.push(question);

        if (options.failCheck) throw new Error('Classifier unavailable');

        return { verdict: options.verdict ?? 'match', usage: { calls: 1, inputTokens: 2, outputTokens: 1 } };
      },
    },
    model,
    onGeneration: (trace) => traces.push(trace.purpose),
    tools: {
      [list]: agentTool({
        description: 'List record references.',
        risk: 'read',
        inputSchema: z.object({}),
        execute: () => ({ refs: values }),
      }),
      [lookup]: agentTool({
        description: 'Read a record using its reference.',
        risk: 'read',
        inputSchema: z.object({
          [field]: options.transform ? z.string().transform((value) => value.toUpperCase()) : z.string(),
        }),
        available: () => !options.unavailable || executions.length === 0,
        execute: (input) => {
          executions.push(input);

          if (options.fail) throw new Error('Read failed');

          return { title: 'Requested record' };
        },
      }),
      erase: agentTool({
        description: 'Erase a record.',
        risk: 'write',
        inputSchema: z.object({ [field]: z.string() }),
        execute: () => {
          throw new Error('Must not execute');
        },
      }),
    },
    policy: {
      maxSteps: options.maxSteps ?? 15,
      authorization: { risks: options.deny ? ['read', 'write'] : ['write'] },
    },
  }).run({ messages: [userMessage('Find my record.')] });

  return { result, executions, traces, checks, controller };
}

describe('bounded discovery', () => {
  const catalogs: [string, string, string][] = [
    ['list_documents', 'open_document', 'document_key'],
    ['scan_devices', 'probe_device', 'serial'],
  ];

  for (const names of catalogs) {
    test(`iterates observed references through ${names[1]} without argument generation`, async () => {
      const { result, executions, traces, checks, controller } = await run({ names });
      expect(executions).toEqual([{ [names[2]]: 'doc-a' }, { [names[2]]: 'doc-b' }]);
      expect(traces).toEqual(['discovery_plan', 'response']);
      expect(controller.consumed).toBe(2);
      expect(checks).toHaveLength(2);
      expect(result.state.discovery[0]).toMatchObject({ total: 2, inspected: 2, status: 'finished' });
      expect(result.state.discovery[0]?.reason).toContain('ambiguous');
      expect(result.state.discovery[0]?.matches).toHaveLength(2);
    });
  }

  test('any match stops early but reports coverage', async () => {
    const { result, executions } = await run({ mode: 'any' });
    expect(executions).toHaveLength(1);
    expect(result.state.discovery[0]).toMatchObject({ total: 2, inspected: 1, status: 'finished' });
  });
  test('no match examines the collection without claiming global absence', async () => {
    const { result } = await run({ verdict: 'no_match' });
    expect(result.state.discovery[0]).toMatchObject({ inspected: 2, matches: [], status: 'finished' });
    expect(result.state.discovery[0]?.reason).toContain('limited to this collection');
  });
  test('budget exhaustion and uncertainty preserve incomplete coverage', async () => {
    for (const options of [{ maxCalls: 1 }, { verdict: 'uncertain' as const }, { maxSteps: 2 }]) {
      const { result, executions } = await run(options);
      expect(executions).toHaveLength(1);
      expect(result.state.discovery[0]).toMatchObject({ inspected: 1, status: 'incomplete' });
    }
  });
  test('denied and failed reads stop without a match judgment', async () => {
    for (const options of [{ deny: true }, { fail: true }]) {
      const { result, checks } = await run(options);
      expect(checks).toHaveLength(0);
      expect(result.state.discovery[0]).toMatchObject({ inspected: 0, status: 'incomplete' });
    }
  });
  test('changed availability stops the continuation', async () => {
    const { result, executions } = await run({ unavailable: true });
    expect(executions).toHaveLength(1);
    expect(result.state.discovery[0]?.status).toBe('incomplete');
  });
  test('rejects writes, unsupported bindings, transformed inputs, and invalid scalar types', async () => {
    for (const options of [{ wrongTool: true }, { wrongPath: true }, { transform: true }, { values: [42, 43] }]) {
      const { executions, traces } = await run(options);
      expect(executions).toHaveLength(0);
      expect(traces.filter((trace) => trace === 'discovery_plan')).toHaveLength(1);
    }
  });
  test('copies nested source fields but never inherited properties', () => {
    expect(discoveryValue({ reference: { key: 'x' } }, ['reference', 'key'])).toBe('x');
    expect(discoveryValue({}, ['constructor'])).toBeUndefined();
  });
  test('rejects unsupported controllers and invalid budgets at configuration', () => {
    const config = {
      instructions: 'Read',
      model: stubModel(),
      controller: scriptedController({ decisions: [] }),
      tools: { read: agentTool({ description: 'Read', risk: 'read', inputSchema: z.object({}), execute: () => null }) },
    };

    expect(() => createAgent({ ...config, discovery: { enabled: true } })).toThrow('evaluateDiscovery');
    expect(() => createAgent({ ...config, discovery: { enabled: true, maxCalls: 0 } })).toThrow('positive integer');
  });
});

test('disabled discovery leaves ordinary controller behavior unchanged', async () => {
  const { executions, traces, result } = await run({ enabled: false });
  expect(executions).toHaveLength(0);
  expect(traces).toEqual(['response']);
  expect(result.state.discovery).toEqual([]);
});

test('a failed semantic check returns to ordinary reasoning without fabricating a match', async () => {
  const { executions, result, controller } = await run({ failCheck: true });
  expect(executions).toHaveLength(1);
  expect(result.state.discovery[0]).toMatchObject({ status: 'incomplete', matches: [] });
  expect(controller.consumed).toBe(2);

  const snapshots = result.messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'data-discovery');

  expect(snapshots[0]?.data.status).toBe('running');
});

test('the live planner contract constrains source to observed collection IDs', async () => {
  const source = stableHash(['index', {}, ['refs'], ['a', 'b']]);

  let observed: unknown;

  const model = new MockLanguageModelV3({
    doGenerate: async ({ responseFormat }) => {
      observed = responseFormat;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              use: false,
              source: '',
              tool: '',
              inputField: '',
              valuePath: [],
              objective: '',
              constraints: [],
              mode: 'all',
            }),
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });

  const base = scriptedController({
    decisions: [
      { type: 'tool_call', tool: 'index', input: {} },
      { type: 'respond', outcome: 'completed' },
    ],
  });

  await createAgent({
    instructions: 'Inspect the references.',
    model,
    respond: async () => ({ text: 'Done.' }),
    controller: { ...base, evaluateDiscovery: async () => ({ verdict: 'uncertain' }) },
    discovery: { enabled: true },
    tools: {
      index: agentTool({
        description: 'List references.',
        inputSchema: z.object({}),
        risk: 'read',
        execute: () => ({ refs: ['a', 'b'] }),
      }),
      read: agentTool({
        description: 'Inspect one reference.',
        inputSchema: z.object({ ref: z.string() }),
        risk: 'read',
        execute: () => null,
      }),
    },
  }).run({ messages: [userMessage('Find the requested record.')] });
  expect(observed).toMatchObject({
    type: 'json',
    schema: {
      properties: {
        source: { enum: ['', source] },
        tool: { enum: ['', 'read'] },
      },
    },
  });
});
