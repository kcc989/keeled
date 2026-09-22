import { describe, expect, test } from 'bun:test';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import {
  reduceState,
  type AgentMessage,
  type Blocker,
  type ControllerContext,
  type Observation,
  type JsonValue,
  type JsonObject,
} from '@keeled/core';
import { jev } from '../src/controller.ts';
import { blockerNote, callHistory, repetitionNote, respondNotes } from '../src/history.ts';
import { controllerState } from '../src/state.ts';
import { testFixture } from '@keeled/core/testing';

function call(tool: string, input: JsonValue, output: JsonValue, id: string): Observation {
  return { id, cycle: 1, kind: 'tool-result', tool, summary: `${tool} returned a result.`, input, detail: output };
}

function context(observations: Observation[], conversation: AgentMessage[] = []): ControllerContext {
  return testFixture<ControllerContext>({
    request: 'Mark my task done.',
    instructions: 'Policy.',
    conversation,
    state: reduceState([]),
    availableTools: [
      { name: 'get_users', description: 'List users.', risk: 'read', required: [] },
      { name: 'update_task_status', description: 'Update a task.', risk: 'write', required: ['task_id', 'status'] },
    ],
    observations,
    blockers: [],
    awaitingConfirmation: [],
    budget: { stepsUsed: 0, maxSteps: 30, remaining: 30 },
    abortSignal: new AbortController().signal,
  });
}

const users = [{ user_id: 'user_1', tasks: ['task_1'] }];

describe('call history', () => {
  test('the reducer keeps the input each tool was called with', () => {
    const state = reduceState([
      // SAFETY: the test fixture intentionally models this exact compile-time shape.
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-update_task_status',
            toolCallId: 'c1',
            state: 'output-available',
            input: { task_id: 'task_1', status: 'completed' },
            output: { status: 'completed' },
          },
        ],
      } as AgentMessage,
    ]);

    expect(state.observations[0]?.input).toEqual({ task_id: 'task_1', status: 'completed' });
  });

  test('includes earlier turns and the current one, with arguments', () => {
    // SAFETY: the test fixture intentionally models this exact compile-time shape.
    const earlier = {
      id: 'a0',
      role: 'assistant',
      parts: [{ type: 'tool-get_users', toolCallId: 'c0', state: 'output-available', input: {}, output: users }],
    } as AgentMessage;

    const history = callHistory(
      context(
        [call('update_task_status', { task_id: 'task_1', status: 'completed' }, { status: 'completed' }, 'c1')],
        [earlier],
      ),
    );

    expect(history).toEqual([
      { ref: 'c0', turn: 'earlier', tool: 'get_users', input: {}, outcome: 'result', result: users },
      {
        ref: 'c1',
        turn: 'current',
        tool: 'update_task_status',
        input: { task_id: 'task_1', status: 'completed' },
        outcome: 'result',
        result: { status: 'completed' },
      },
    ]);
  });

  test('notes report repetition and the latest result without judging further calls', () => {
    const once = callHistory(context([call('get_users', {}, users, 'c1')]));
    expect(repetitionNote('get_users', once)).toBe(
      ' Called once this turn. Latest result: [{"user_id":"user_1","tasks":["task_1"]}]',
    );
    expect(repetitionNote('update_task_status', once)).toBe('');

    const twice = callHistory(context([call('get_users', {}, users, 'c1'), call('get_users', {}, users, 'c2')]));
    expect(repetitionNote('get_users', twice)).toBe(
      ' Called 2 times this turn (2 of them with the latest input; the last two returned identical results).' +
        ' Latest result: [{"user_id":"user_1","tasks":["task_1"]}]',
    );

    const transfers = callHistory(
      context([
        call('transfer', { summary: 'a' }, 'Transfer successful', 'c1'),
        call('transfer', { summary: 'b' }, 'Transfer successful', 'c2'),
      ]),
    );

    expect(repetitionNote('transfer', transfers)).toBe(
      ' Called 2 times this turn (1 of them with the latest input; the last two returned identical results).' +
        ' Latest result: Transfer successful',
    );

    for (const note of [once, twice, transfers].map((history) => repetitionNote('get_users', history))) {
      expect(note).not.toContain('will not');
      expect(note).not.toContain('done');
    }
  });

  test('a failed call is reported as failed', () => {
    const failed = callHistory(
      context([
        { id: 'c1', cycle: 1, kind: 'tool-error', tool: 'cancel', summary: 'Error: not found', input: { id: 'X' } },
      ]),
    );

    expect(repetitionNote('cancel', failed)).toBe(' Called once this turn. Latest call failed: Error: not found');
  });

  test('Jev is asked with the history in its state and the notes in its options', async () => {
    const requests: { state: JsonObject; questions: { [key: string]: { criteria?: { [key: string]: string } } } }[] =
      [];

    // SAFETY: the test fixture intentionally models this exact compile-time shape.
    const client = testFixture<TypeSafeClient>({
      async systemOne(request: (typeof requests)[number]) {
        requests.push(request);

        return {
          answers: { action: { choice: 'respond:completed', confidence: 1, probabilities: {} } },
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    });

    const decision = await jev({ client }).control(
      context([call('get_users', {}, users, 'c1'), call('get_users', {}, users, 'c2')]),
    );

    expect(decision.action).toEqual({ type: 'respond', outcome: 'completed' });
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions)).toEqual(['action']);
    expect(JSON.stringify(requests[0]!.questions.action)).toContain('respond:completed');
    expect(requests[0]!.state).not.toHaveProperty('task_state');
    expect(requests[0]!.state).not.toHaveProperty('current_goal');

    const request = requests[0]!;
    expect(request.state['tool_calls']).toEqual([
      { ref: 'c1', turn: 'current', tool: 'get_users', input: {}, outcome: 'result', result: users },
      { ref: 'c2', turn: 'current', tool: 'get_users', input: {}, outcome: 'result', result: users },
    ]);
    expect(JSON.stringify(request.questions['action'])).toContain('the last two returned identical results');
  });
});

describe('what Jev is shown', () => {
  // The shape that broke record projection: the field the next step needs comes last.
  const userDetails = {
    user_id: 'raj_sanchez_7340',
    name: { first_name: 'Raj', last_name: 'Sanchez' },
    address: {
      address1: '123 Main St',
      address2: 'Suite 400',
      city: 'Philadelphia',
      country: 'USA',
      state: 'PA',
      zip: '19103',
    },
    email: 'raj.sanchez@example.com',
    dob: '1966-10-08',
    payment_methods: {
      credit_card_1: { source: 'credit_card', brand: 'visa', last_four: '1234', id: 'credit_card_1' },
      gift_card_2: { source: 'gift_card', amount: 150, id: 'gift_card_2' },
      certificate_3: { source: 'certificate', amount: 250, id: 'certificate_3' },
    },
    saved_contacts: [{ first_name: 'Maria', last_name: 'Sanchez', dob: '1970-01-01' }],
    membership: 'silver',
    documents: ['MZDDS4', '60RX9E', 'S5IK51', 'OUEA45', 'Q69X3R'],
  };

  test('a full result reaches Jev, including fields at the end', () => {
    const state = controllerState(
      context([call('get_user_details', { user_id: 'raj_sanchez_7340' }, userDetails, 'c1')]),
    );

    expect(JSON.stringify(userDetails).length).toBeGreaterThan(600);
    expect(state['tool_calls']).toEqual([
      {
        ref: 'c1',
        turn: 'current',
        tool: 'get_user_details',
        input: { user_id: 'raj_sanchez_7340' },
        outcome: 'result',
        result: userDetails,
      },
    ]);
    // Tool results are not repeated in the evidence list.
    expect(state['evidence']).toEqual([]);
  });
});

describe('authorization', () => {
  test('one request carries the pending action and the three questions', async () => {
    const requests: { state: JsonObject; questions: JsonObject }[] = [];

    // SAFETY: the test fixture intentionally models this exact compile-time shape.
    const client = testFixture<TypeSafeClient>({
      async systemOne(request: (typeof requests)[number]) {
        requests.push(request);

        return {
          answers: { permitted: { noul: 0.9 }, needs_verification: { noul: 0.8 }, confirmed: { noul: 0.1 } },
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    });

    const answer = await jev({ client }).authorize!(context([]), {
      tool: 'cancel_document',
      description: 'Cancel the whole document.',
      risk: 'write',
      input: { document_id: 'Q69X3R' },
      facts: {},
      effects: [],
    });

    expect(Object.keys(requests[0]!.questions).sort()).toEqual(['confirmed', 'needs_verification', 'permitted']);
    expect(requests[0]!.state['pending_action']).toEqual({
      tool: 'cancel_document',
      description: 'Cancel the whole document.',
      risk: 'write',
      input: { document_id: 'Q69X3R' },
      verified_facts: {},
      effects: [],
    });
    expect(answer.permitted.value).toBe(true);
    expect(answer.needsVerification.value).toBe(true);
    expect(answer.confirmed.value).toBe(false);
  });

  test('a blocked tool carries its kind, reason, and resolution into its option', () => {
    const blocker = (kind: Blocker['kind'], reason: string, resolution: string) =>
      // SAFETY: the test fixture intentionally models this exact compile-time shape.
      ({ id: 'b', cycle: 1, kind, tool: 'cancel', input: { id: 'X' }, reason, resolution }) as Blocker;

    expect(blockerNote('cancel', [blocker('needs_confirmation', 'Awaiting confirmation.', 'Ask the user.')])).toBe(
      ' Blocked this turn (needs_confirmation): Awaiting confirmation. To resolve: Ask the user.',
    );
    expect(blockerNote('lookup', [blocker('policy_denied', 'No.', 'Explain.')])).toBe('');
    expect(
      blockerNote('cancel', [
        blocker('policy_denied', 'Not permitted.', 'Explain.'),
        blocker('policy_denied', 'Not permitted.', 'Explain.'),
      ]),
    ).toBe(' Blocked 2 times this turn (policy_denied): Not permitted. To resolve: Explain.');
  });

  test('a pending confirmation points the respond option at asking the user', () => {
    const notes = respondNotes([
      {
        id: 'b',
        cycle: 1,
        kind: 'needs_confirmation',
        tool: 'cancel',
        input: { id: 'X' },
        reason: 'r',
        resolution: 'Ask.',
      },
    ]);

    expect(notes.needsInput).toBe(
      ' An action awaits the user\'s explicit confirmation: cancel({"id":"X"}). Asking the user to confirm it resolves this.',
    );
  });
});

test('Jev selects exact held inputs without confusing resume labels with registered tools', async () => {
  const c = context([]);
  const input = { task_id: 'new', status: 'done' };
  const available = [...c.availableTools, { ...c.availableTools[0]!, name: 'resume:1' }];
  let criteria: JsonObject = {};

  const client = testFixture<TypeSafeClient>({
    systemOne: async (request: { questions: { action: { criteria: JsonObject } } }) => {
      criteria = request.questions.action.criteria;

      return {
        answers: { action: { choice: ':resume:1', confidence: 1, probabilities: { ':resume:1': 1 } } },
        usage: { input_tokens: 100, output_tokens: 4 },
      };
    },
  });

  const result = await jev({ client }).control({
    ...c,
    availableTools: available,
    awaitingConfirmation: [
      { tool: 'update_task_status', input: { task_id: 'old', status: 'done' }, reason: 'Earlier proposal.' },
      { tool: 'update_task_status', input, reason: 'Latest proposal.' },
      { tool: 'unavailable', input: { id: 'hidden' }, reason: 'Unavailable tool.' },
    ],
  });

  expect(result.action).toEqual({ type: 'tool_call', tool: 'update_task_status', input });
  expect(criteria).toHaveProperty('resume:1');
  expect(criteria).toHaveProperty(':resume:1');
  expect(Object.values(criteria).join('\n')).not.toContain('Unavailable tool.');
  expect(result.action.type === 'tool_call' && result.action.input).not.toBe(input);
});
