import { describe, expect, test } from 'bun:test';
import { scriptedController, stubModel } from '@keeled/core/testing';
import { Session, SessionConflictError } from '../src/session.ts';
import { describe as describeTool, type ToolSpec } from '../src/tools.ts';

const policy = '# Policy\n\n1. Each task must have a title\n';

const tools: ToolSpec[] = [
  {
    name: 'get_users',
    description: 'List users.',
    parameters: { type: 'object', properties: {} },
    risk: 'read',
  },
  {
    name: 'create_task',
    description: 'Create a task.',
    parameters: {
      type: 'object',
      properties: { user_id: { type: 'string' }, title: { type: 'string' } },
      required: ['user_id', 'title'],
    },
    risk: 'write',
  },
];

function session(decisions: Parameters<typeof scriptedController>[0]['decisions']) {
  const controller = scriptedController({ decisions });
  const model = stubModel({ text: 'Created.', objects: [{ status: 'ready', arguments: { user_id: 'user_1', title: 'Meeting' } }] });
  return { controller, session: new Session({ instructions: policy, tools, controller, model }) };
}

describe('tau bridge session', () => {
  test('surfaces each controller-selected tool call and resumes with its result', async () => {
    const { controller, session: s } = session([
      { type: 'tool', tool: 'get_users' },
      { type: 'tool', tool: 'create_task' },
      { type: 'respond', outcome: 'completed' },
    ]);

    const first = await s.sendUser('Create a task called Meeting for user_1.');
    expect(first).toMatchObject({ type: 'tool_call', name: 'get_users', arguments: {} });
    expect(first.decisions.map(d => d.action)).toEqual([{ type: 'tool', tool: 'get_users' }]);

    const second = await s.sendToolResult({ id: first.type === 'tool_call' ? first.id : '', content: '[{"user_id":"user_1"}]' });
    expect(second).toMatchObject({
      type: 'tool_call',
      name: 'create_task',
      arguments: { user_id: 'user_1', title: 'Meeting' },
    });

    const final = await s.sendToolResult({ id: second.type === 'tool_call' ? second.id : '', content: '{"task_id":"task_9"}' });
    expect(final).toMatchObject({ type: 'message', text: 'Created.', stopReason: 'completed' });
    expect(final.decisions.map(d => d.action.type)).toEqual(['respond']);

    expect(controller.contexts[0]?.instructions).toBe(policy);
    const outputs = s.messages.flatMap(m => m.parts).filter(p => p.type === 'tool-create_task');
    expect(outputs).toMatchObject([{ state: 'output-available', output: { task_id: 'task_9' } }]);
  });

  test('a failed remote tool becomes a tool error observation', async () => {
    const { session: s } = session([
      { type: 'tool', tool: 'get_users' },
      { type: 'respond', outcome: 'blocked' },
    ]);
    const call = await s.sendUser('List users.');
    const final = await s.sendToolResult({ id: call.type === 'tool_call' ? call.id : '', content: 'Error: down', error: true });
    expect(final).toMatchObject({ type: 'message', stopReason: 'blocked' });
    const parts = s.messages.flatMap(m => m.parts).filter(p => p.type === 'tool-get_users');
    expect(parts).toMatchObject([{ state: 'output-error', errorText: 'Error: down' }]);
  });

  test('a later turn still sees tool results from earlier turns', async () => {
    const controller = scriptedController({
      decisions: [
        { type: 'tool', tool: 'create_task' },
        { type: 'respond', outcome: 'completed' },
        { type: 'respond', outcome: 'completed' },
      ],
    });
    const model = stubModel({
      text: prompt => (prompt.includes('task_9') ? 'Grounded.' : 'Ungrounded.'),
      objects: [{ status: 'ready', arguments: { user_id: 'user_1', title: 'Meeting' } }],
    });
    const s = new Session({ instructions: policy, tools, controller, model });

    const call = await s.sendUser('Create a task called Meeting for user_1.');
    await s.sendToolResult({ id: call.type === 'tool_call' ? call.id : '', content: '{"task_id":"task_9"}' });
    const followUp = await s.sendUser('Thanks, that is all.');
    expect(followUp).toMatchObject({ type: 'message', text: 'Grounded.' });
  });

  test('the controller sees what each tool returns', async () => {
    const usersReturn = {
      $defs: {
        User: {
          type: 'object',
          properties: { user_id: { type: 'string' }, name: { type: 'string' }, tasks: { type: 'array', items: { type: 'string' } } },
        },
      },
      type: 'object',
      properties: { returns: { type: 'array', items: { $ref: '#/$defs/User' } } },
    };
    const transferReturn = {
      type: 'object',
      properties: { returns: { type: 'string', description: 'A transfer confirmation.' } },
    };
    expect(describeTool({ ...tools[0]!, returns: usersReturn })).toBe(
      'List users. Returns { user_id: string, name: string, tasks: string[] }[].',
    );
    expect(describeTool({ name: 't', description: 'Transfer!', parameters: {}, returns: transferReturn })).toBe(
      'Transfer! Returns a string: A transfer confirmation.',
    );

    const controller = scriptedController({ decisions: [{ type: 'respond', outcome: 'needs_input' }] });
    const s = new Session({
      instructions: policy,
      tools: [{ ...tools[0]!, returns: usersReturn }, tools[1]!],
      controller,
      model: stubModel(),
    });
    await s.sendUser('Mark my task done.');
    expect(controller.contexts[0]?.availableTools.find(tool => tool.name === 'get_users')?.description).toContain(
      'tasks: string[]',
    );
  });

  test('replies know the agent has tools and what they need', async () => {
    const controller = scriptedController({ decisions: [{ type: 'respond', outcome: 'needs_input' }] });
    const model = stubModel({
      text: prompt =>
        prompt.includes('create_task(user_id, title)') && !prompt.includes('You have no tools') ? 'Aware.' : 'Unaware.',
    });
    const s = new Session({ instructions: policy, tools, controller, model });
    expect(await s.sendUser('Make a task.')).toMatchObject({ type: 'message', text: 'Aware.' });
  });

  test('prompts see a long tool result in full, including its last field', async () => {
    const long = { user_id: 'user_1', padding: 'p'.repeat(900), reservations: ['MZDDS4', 'Q69X3R'] };
    const controller = scriptedController({
      decisions: [
        { type: 'tool', tool: 'get_users' },
        { type: 'respond', outcome: 'completed' },
      ],
    });
    const prompts: string[] = [];
    const model = stubModel({
      text: prompt => {
        prompts.push(prompt);
        return 'Done.';
      },
    });
    const s = new Session({ instructions: policy, tools, controller, model });
    const call = await s.sendUser('Which reservations do I have?');
    const final = await s.sendToolResult({ id: call.type === 'tool_call' ? call.id : '', content: JSON.stringify(long) });
    expect(final).toMatchObject({ type: 'message', text: 'Done.' });
    expect(prompts.at(-1)).toContain('Q69X3R');
  });

  test('the resolver can report missing information instead of inventing input', async () => {
    const controller = scriptedController({
      decisions: [
        { type: 'tool', tool: 'create_task' },
        { type: 'respond', outcome: 'needs_input' },
      ],
    });
    const model = stubModel({
      text: 'Which user is the task for?',
      objects: [{ status: 'missing', missing: 'the user id, from the user' }],
    });
    const s = new Session({ instructions: policy, tools, controller, model });
    const reply = await s.sendUser('Create a task called Meeting.');
    expect(reply).toMatchObject({ type: 'message', stopReason: 'needs_input' });
    const blockers = s.messages.flatMap(m => m.parts).filter(p => p.type === 'data-blocker');
    expect(blockers).toMatchObject([
      { data: { kind: 'missing_evidence', tool: 'create_task', resolution: expect.stringContaining('the user id') } },
    ]);
  });

  test('invalid replies use a status fallback without a repair call', async () => {
    const controller = scriptedController({ decisions: [{ type: 'respond', outcome: 'needs_input' }] });
    const fast = stubModel({ text: '<｜DSML｜ invoke name="get_users">' });
    const careful = stubModel({ text: 'Which task should I create?' });
    const s = new Session({ instructions: policy, tools, controller, model: careful, argumentsModel: fast });
    const event = await s.sendUser('Help me.');
    expect(event).toMatchObject({ type: 'message', text: 'More information is needed before this request can continue.' });
    expect(event.trace.filter(entry => entry.kind === 'generate')).toHaveLength(1);
  });

  test('rejects results for calls that are not pending', async () => {
    const { session: s } = session([{ type: 'tool', tool: 'get_users' }]);
    await s.sendUser('List users.');
    expect(() => s.sendToolResult({ id: 'nope', content: '[]' })).toThrow(SessionConflictError);
    expect(() => s.sendUser('again')).toThrow(SessionConflictError);
    s.close();
  });
});
