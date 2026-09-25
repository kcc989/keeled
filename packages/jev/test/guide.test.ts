import { describe, expect, test } from 'bun:test';
import type { SystemOneRequest, TypeSafeClient } from '@typesafe-ai/sdk';
import { reduceState, type AgentMessage, type ControllerContext, type Observation } from '@keeled/core';
import { testFixture } from '@keeled/core/testing';
import { jev, type ToolGuideEvent } from '../src/controller.ts';
import {
  buildGuide,
  guideNote,
  guideOptions,
  segmentInstructions,
  taggedInstructions,
  userSource,
  type GuideAsk,
} from '../src/guide.ts';

interface CatalogTool {
  name: string;
  description: string;
  risk: 'read' | 'write';
  required: string[];
}

/** What a perfect judge would answer about one synthetic setting. */
interface Truth {
  /** For each tool, substrings of the segments that set a rule for it. */
  rules: { [tool: string]: string[] };
  /** Segments a Choice ranks highly for a tool that do not set a rule for it. */
  decoys?: { [tool: string]: string[] };
  /** For each tool input, the tool that supplies it, or `userSource`. */
  sources: { [tool: string]: { [parameter: string]: string } };
  /** A Choice puts all its mass on one segment, as Jev does over long instructions. */
  sharp?: boolean;
}

interface Setting {
  instructions: string;
  tools: CatalogTool[];
  truth: Truth;
}

interface OracleAnswer {
  type: 'choice' | 'noul';
  choice?: string;
  confidence?: number;
  probabilities?: { [label: string]: number };
  noul?: number;
}

interface Sent {
  state: { instructions?: string };
  questions: {
    [name: string]: {
      type: string;
      instructions?: string;
      criteria?: { [label: string]: string | null };
    };
  };
}

/**
 * A stand-in for Jev that answers from a truth table. It reads segment text from the tagged
 * instructions it is sent, so it also checks that the numbered lines match the segments.
 */
function oracle(truth: Truth) {
  const sent: Sent[] = [];

  const answer = (request: Sent) => {
    const text = new Map(
      (request.state.instructions ?? '').split('\n').flatMap((line) => {
        const match = /^(I\d+)\| (.*)$/.exec(line);

        return match === null ? [] : [[match[1]!, match[2]!] as const];
      }),
    );

    const matches = (id: string, needles: readonly string[] | undefined) =>
      (needles ?? []).some((needle) => text.get(id)?.includes(needle) === true);

    const answers: { [name: string]: OracleAnswer } = {};

    for (const [name, question] of Object.entries(request.questions)) {
      const prompt = question.instructions ?? '';
      const tool = /tool "([^"]+)"/.exec(prompt)?.[1] ?? '';

      if (name === 'action') {
        answers[name] = { type: 'choice', choice: 'respond:completed', confidence: 1, probabilities: {} };
      } else if (name.startsWith('g')) {
        answers[name] = { type: 'noul', noul: (truth.rules[tool] ?? []).length > 0 ? 0.92 : 0.06 };
      } else if (name.startsWith('w')) {
        const ids = Object.keys(question.criteria ?? {});

        const favored = ids.filter((id) => matches(id, truth.rules[tool]) || matches(id, truth.decoys?.[tool]));

        // Like the real model, a Choice always ranks some segment first.
        const top = favored.length > 0 ? (truth.sharp === true ? favored.slice(0, 1) : favored) : [ids[0]!];

        // A sharp Choice gives every other segment exactly zero, as observed from Jev.
        const rest = truth.sharp === true ? 0 : 0.1 / (ids.length - top.length || 1);
        const mass = truth.sharp === true ? 1 : 0.9;

        const probabilities = Object.fromEntries(ids.map((id) => [id, top.includes(id) ? mass / top.length : rest]));

        answers[name] = { type: 'choice', choice: top[0]!, confidence: 0.9, probabilities };
      } else if (name.startsWith('s')) {
        const parameter = /input "([^"]+)"/.exec(prompt)?.[1] ?? '';
        const labels = Object.keys(question.criteria ?? {});
        const expected = truth.sources[tool]?.[parameter] ?? userSource;

        const probabilities = Object.fromEntries(
          labels.map((label) => [label, label === expected ? 0.85 : 0.15 / (labels.length - 1)]),
        );

        answers[name] = { type: 'choice', choice: expected, confidence: 0.85, probabilities };
      } else if (name.startsWith('r')) {
        const segment = /segment (I\d+)/.exec(prompt)?.[1] ?? '';

        answers[name] = { type: 'noul', noul: matches(segment, truth.rules[tool]) ? 0.9 : 0.1 };
      }
    }

    return { answers, usage: { input_tokens: 100, output_tokens: 1 } };
  };

  const ask: GuideAsk = async (state, questions) => {
    // SAFETY: the test fixture intentionally models this exact compile-time shape.
    const request = { state, questions } as Sent;
    sent.push(request);

    // SAFETY: the oracle returns one Choice or Noul answer per question, as the SDK does.
    return answer(request) as Awaited<ReturnType<GuideAsk>>;
  };

  // SAFETY: the test fixture intentionally models this exact compile-time shape.
  const client = testFixture<TypeSafeClient>({
    async systemOne(request: Sent) {
      sent.push(request);

      return answer(request);
    },
  });

  return { ask, client, sent };
}

const library: Setting = {
  instructions: [
    '# Loans',
    '',
    '- Look up the member before listing their loans.',
    '- A loan can be renewed at most twice.',
    '- Before renewing, the member must say which loan:',
    '  - Read the loan title back to them.',
    '',
    '# Opening hours',
    '',
    'The branch opens at nine and closes at six.',
  ].join('\n'),
  tools: [
    { name: 'find_member', description: 'Find a member by email.', risk: 'read', required: ['email'] },
    { name: 'list_loans', description: 'List the loans of a member.', risk: 'read', required: ['member_id'] },
    { name: 'renew_loan', description: 'Renew one loan.', risk: 'write', required: ['loan_id'] },
  ],
  truth: {
    rules: {
      list_loans: ['Look up the member before listing'],
      renew_loan: ['renewed at most twice', 'Before renewing', 'Read the loan title back'],
    },
    sources: {
      find_member: { email: userSource },
      list_loans: { member_id: 'find_member' },
      renew_loan: { loan_id: 'list_loans' },
    },
  },
};

/** The same setting with every tool renamed, so no rule can depend on a tool name. */
const renamed: Setting = {
  instructions: library.instructions,
  tools: [
    { name: 'patron_lookup', description: 'Find a member by email.', risk: 'read', required: ['email'] },
    { name: 'items_out', description: 'List the loans of a member.', risk: 'read', required: ['member_id'] },
    { name: 'extend', description: 'Renew one loan.', risk: 'write', required: ['loan_id'] },
  ],
  truth: {
    rules: {
      items_out: ['Look up the member before listing'],
      extend: ['renewed at most twice', 'Before renewing', 'Read the loan title back'],
    },
    sources: {
      patron_lookup: { email: userSource },
      items_out: { member_id: 'patron_lookup' },
      extend: { loan_id: 'items_out' },
    },
  },
};

const deployment: Setting = {
  instructions: [
    'Deployments follow these steps:',
    '1. Fetch the build and check that its tests passed.',
    '2. Promote a build to production only on weekdays.',
    'Roll back only when the on-call engineer asks for it. Record the reason for every rollback.',
  ].join('\n'),
  tools: [
    { name: 'get_build', description: 'Fetch a build by number.', risk: 'read', required: ['build'] },
    { name: 'promote', description: 'Promote a build to production.', risk: 'write', required: ['build_id'] },
    { name: 'rollback', description: 'Restore the previous release.', risk: 'write', required: ['reason'] },
  ],
  truth: {
    rules: {
      get_build: ['Fetch the build'],
      promote: ['Fetch the build', 'only on weekdays'],
      rollback: ['Roll back only when'],
    },
    sources: {
      get_build: { build: userSource },
      promote: { build_id: 'get_build' },
      rollback: { reason: userSource },
    },
  },
};

const options = guideOptions();

describe('segmenting instructions', () => {
  test('headings, lead-in lines, and parent items become the scope of each segment', () => {
    const segments = segmentInstructions(library.instructions);

    expect(segments.map((segment) => segment.text)).toEqual([
      'Look up the member before listing their loans.',
      'A loan can be renewed at most twice.',
      'Before renewing, the member must say which loan:',
      'Read the loan title back to them.',
      'The branch opens at nine and closes at six.',
    ]);
    expect(segments.map((segment) => segment.id)).toEqual(['I000', 'I001', 'I002', 'I003', 'I004']);
    expect(segments[0]!.context).toEqual(['Loans']);
    expect(segments[3]!.context).toEqual(['Loans', 'Before renewing, the member must say which loan:']);
    expect(segments[4]!.context).toEqual(['Opening hours']);
  });

  test('a lead-in line scopes the numbered steps below it', () => {
    const segments = segmentInstructions(deployment.instructions);

    expect(segments[1]!.context).toEqual(['Deployments follow these steps:']);
    expect(segments[2]!.context).toEqual(['Deployments follow these steps:']);
    // A plain line ends the lead-in.
    expect(segments[3]!.context).toEqual([]);
  });

  test('a long line splits at sentence ends and keeps each sentence whole', () => {
    const sentence = 'Every request needs a ticket number that the requester supplies in writing.';
    const text = Array.from({ length: 8 }, () => sentence).join(' ');
    const segments = segmentInstructions(text, 200);

    expect(segments.length).toBeGreaterThan(1);
    expect(segments.map((segment) => segment.text).join(' ')).toBe(text);

    for (const segment of segments) expect(segment.text.length).toBeLessThanOrEqual(200);

    const long = 'x'.repeat(500);
    expect(segmentInstructions(long, 200).map((segment) => segment.text)).toEqual([long]);
  });

  test('the tagged text keeps headings and numbers every segment', () => {
    expect(taggedInstructions(library.instructions).split('\n')).toEqual([
      '# Loans',
      'I000| Look up the member before listing their loans.',
      'I001| A loan can be renewed at most twice.',
      'I002| Before renewing, the member must say which loan:',
      'I003| Read the loan title back to them.',
      '# Opening hours',
      'I004| The branch opens at nine and closes at six.',
    ]);
  });
});

describe('building the guide', () => {
  for (const setting of [library, renamed, deployment]) {
    test(`finds the governing segments and input sources (${setting.tools[0]!.name})`, async () => {
      const { ask } = oracle(setting.truth);
      const guide = await buildGuide(ask, 'k', setting.instructions, setting.tools, options);
      const text = new Map(guide.segments.map((segment) => [segment.id, segment.text]));

      for (const tool of setting.tools) {
        const entry = guide.tools.find((candidate) => candidate.tool === tool.name)!;
        const expected = setting.truth.rules[tool.name] ?? [];

        expect(entry.rules.map((rule) => text.get(rule.segment))).toEqual(
          guide.segments
            .filter((segment) => expected.some((needle) => segment.text.includes(needle)))
            .map((segment) => segment.text),
        );

        expect(Object.fromEntries(entry.sources.map((source) => [source.parameter, source.source]))).toEqual(
          setting.truth.sources[tool.name]!,
        );
      }
    });
  }

  test('renaming every tool changes only the names in the guide', async () => {
    const original = await buildGuide(oracle(library.truth).ask, 'k', library.instructions, library.tools, options);
    const other = await buildGuide(oracle(renamed.truth).ask, 'k', renamed.instructions, renamed.tools, options);
    const names = new Map(library.tools.map((tool, index) => [tool.name, renamed.tools[index]!.name]));

    expect(other.tools).toEqual(
      original.tools.map((entry) => ({
        ...entry,
        tool: names.get(entry.tool)!,
        sources: entry.sources.map((source) => ({ ...source, source: names.get(source.source) ?? source.source })),
      })),
    );
  });

  test('a tool no segment governs gets no rule, although a Choice ranks some segment first', async () => {
    const { ask, sent } = oracle({ rules: {}, sources: {} });
    const shortlist = await buildGuide(ask, 'k', library.instructions, library.tools, { ...options, pairBudget: 0 });

    expect(shortlist.tools.every((entry) => entry.rules.length === 0)).toBe(true);
    // In shortlist mode the Noul gate stops the confirmation pass.
    expect(sent.flatMap((request) => Object.keys(request.questions)).some((name) => name.startsWith('r'))).toBe(false);

    const every = await buildGuide(
      oracle({ rules: {}, sources: {} }).ask,
      'k',
      library.instructions,
      library.tools,
      options,
    );

    expect(every.tools.every((entry) => entry.rules.length === 0)).toBe(true);
  });

  test('every pair within the budget is checked, so a sharp Choice does not limit recall', async () => {
    const instructions = Array.from({ length: 12 }, (_, n) => `- Export rule ${n}: check condition ${n}.`)
      .concat(['- Import files only from the shared folder.'])
      .join('\n');

    const tools: CatalogTool[] = [
      { name: 'export', description: 'Export a report.', risk: 'write', required: [] },
      { name: 'import', description: 'Import a file.', risk: 'write', required: [] },
    ];

    const truth: Truth = { rules: { export: ['Export rule'], import: ['Import files'] }, sources: {}, sharp: true };
    const every = await buildGuide(oracle(truth).ask, 'k', instructions, tools, options);
    const shortlist = await buildGuide(oracle(truth).ask, 'k', instructions, tools, { ...options, pairBudget: 0 });

    expect(every.tools[0]!.rules).toHaveLength(12);
    expect(every.tools[1]!.rules.map((rule) => rule.segment)).toEqual(['I012']);
    expect(shortlist.tools[0]!.rules).toHaveLength(1);
  });

  test('a highly ranked segment that does not set a rule is dropped on confirmation', async () => {
    const truth: Truth = {
      ...library.truth,
      decoys: { list_loans: ['The branch opens at nine'] },
    };

    const guide = await buildGuide(oracle(truth).ask, 'k', library.instructions, library.tools, {
      ...options,
      pairBudget: 0,
    });

    const entry = guide.tools.find((candidate) => candidate.tool === 'list_loans')!;

    expect(entry.rules.map((rule) => rule.segment)).toEqual(['I000']);
  });

  test('instructions with no segments ask only about input sources', async () => {
    const { ask, sent } = oracle(library.truth);
    const guide = await buildGuide(ask, 'k', '\n\n', library.tools, options);

    expect(guide.segments).toEqual([]);
    expect(guide.tools.every((entry) => entry.rules.length === 0 && entry.governed === 0)).toBe(true);
    expect(sent.flatMap((request) => Object.keys(request.questions)).every((name) => name.startsWith('s'))).toBe(true);
  });

  test('a Choice never has more than 250 options, and requests stay within the question limit', async () => {
    const instructions = Array.from({ length: 260 }, (_, n) => `- Rule number ${n} applies to archiving.`).join('\n');

    const tools: CatalogTool[] = [
      { name: 'archive', description: 'Archive a record.', risk: 'write', required: ['record'] },
      { name: 'fetch', description: 'Fetch a record.', risk: 'read', required: [] },
    ];

    const { ask, sent } = oracle({ rules: { archive: ['Rule number 255 '] }, sources: {} });

    const guide = await buildGuide(ask, 'k', instructions, tools, {
      ...options,
      questionsPerRequest: 3,
      pairBudget: 0,
    });

    const questions = sent.flatMap((request) => Object.entries(request.questions));

    for (const request of sent) expect(Object.keys(request.questions).length).toBeLessThanOrEqual(3);

    for (const [, question] of questions) {
      if (question.type === 'choice') expect(Object.keys(question.criteria ?? {}).length).toBeLessThanOrEqual(250);
    }

    expect(questions.map(([name]) => name)).toContain('w0_1');
    expect(guide.tools[0]!.rules.map((rule) => rule.segment)).toEqual(['I255']);
    expect(guide.usage).toEqual({ calls: sent.length, inputTokens: 100 * sent.length, outputTokens: sent.length });
  });
});

describe('the guide in a tool option', () => {
  test('quotes the governing segments and reports whether each input source has run', async () => {
    const guide = await buildGuide(oracle(library.truth).ask, 'k', library.instructions, library.tools, options);

    expect(guideNote('list_loans', guide, [], options)).toBe(
      ' Instructions for this tool: [I000] Loans › Look up the member before listing their loans.' +
        ' Inputs: "member_id" usually comes from find_member (not called yet in this conversation).',
    );

    const found = [
      { ref: 'c1', turn: 'current' as const, tool: 'find_member', input: {}, outcome: 'result' as const, result: {} },
    ];

    expect(guideNote('list_loans', guide, found, options)).toContain(
      '"member_id" usually comes from find_member (it has returned a result in this conversation)',
    );

    const failed = [{ ...found[0]!, outcome: 'error' as const, result: 'not found' }];
    expect(guideNote('list_loans', guide, failed, options)).toContain('(its calls so far have failed)');

    // An input the user supplies adds nothing, and a tool without rules gets no note.
    expect(guideNote('find_member', guide, [], options)).toBe('');
    expect(guideNote('unknown_tool', guide, [], options)).toBe('');
  });

  test('a lead-in line quoted as the scope of another rule is not repeated', async () => {
    const guide = await buildGuide(oracle(library.truth).ask, 'k', library.instructions, library.tools, options);
    const note = guideNote('renew_loan', guide, [], options);

    expect(guide.tools.find((entry) => entry.tool === 'renew_loan')!.rules.map((rule) => rule.segment)).toEqual([
      'I001',
      'I002',
      'I003',
    ]);
    expect(note).toBe(
      ' Instructions for this tool: [I001] Loans › A loan can be renewed at most twice.' +
        ' | [I003] Loans › Before renewing, the member must say which loan: › Read the loan title back to them.' +
        ' Inputs: "loan_id" usually comes from list_loans (not called yet in this conversation).',
    );
  });

  test('a rule shared by nearly every tool stays in the guide but not in tool options', async () => {
    const instructions = ['- Make one call at a time.', '- Close a ticket only after the fix is verified.'].join('\n');

    const tools: CatalogTool[] = [
      { name: 'open_ticket', description: 'Open a ticket.', risk: 'write', required: [] },
      { name: 'close_ticket', description: 'Close a ticket.', risk: 'write', required: [] },
      { name: 'read_ticket', description: 'Read a ticket.', risk: 'read', required: [] },
      { name: 'assign', description: 'Assign a ticket.', risk: 'write', required: [] },
    ];

    const truth: Truth = {
      rules: {
        open_ticket: ['one call at a time'],
        close_ticket: ['one call at a time', 'Close a ticket only'],
        read_ticket: ['one call at a time'],
        assign: ['one call at a time'],
      },
      sources: {},
    };

    const guide = await buildGuide(oracle(truth).ask, 'k', instructions, tools, options);

    expect(guide.tools.every((entry) => entry.rules.some((rule) => rule.segment === 'I000'))).toBe(true);
    expect(guideNote('close_ticket', guide, [], options)).toBe(
      ' Instructions for this tool: [I001] Close a ticket only after the fix is verified.',
    );
    expect(guideNote('open_ticket', guide, [], options)).toBe('');
    expect(guideNote('open_ticket', guide, [], { ...options, sharedRuleShare: 1 })).toContain('[I000]');
  });

  test('a source below the floor is not reported', async () => {
    const guide = await buildGuide(oracle(library.truth).ask, 'k', library.instructions, library.tools, options);

    expect(guideNote('renew_loan', guide, [], { ...options, sourceFloor: 0.9 })).not.toContain('Inputs:');
  });
});

function context(
  instructions: string,
  tools: readonly CatalogTool[],
  observations: Observation[] = [],
  abortSignal = new AbortController().signal,
): ControllerContext {
  return testFixture<ControllerContext>({
    request: 'Help me.',
    instructions,
    conversation: [] satisfies AgentMessage[],
    state: reduceState([]),
    availableTools: tools,
    observations,
    blockers: [],
    awaitingConfirmation: [],
    budget: { stepsUsed: 0, maxSteps: 30, remaining: 30 },
    abortSignal,
  });
}

function actionCriteria(sent: readonly Sent[]): { [label: string]: string | null } {
  return sent.findLast((request) => 'action' in request.questions)!.questions['action']!.criteria ?? {};
}

describe('the Jev controller with a tool guide', () => {
  test('without the option, selection sends one request and no guide note', async () => {
    const { client, sent } = oracle(library.truth);
    await jev({ client }).control(context(library.instructions, library.tools));

    expect(sent).toHaveLength(1);
    expect(actionCriteria(sent)['list_loans']).not.toContain('Instructions for this tool');
  });

  test('builds once per instructions and catalog, and charges its usage once', async () => {
    const { client, sent } = oracle(library.truth);
    const events: ToolGuideEvent[] = [];
    const controller = jev({ client, toolGuide: true, onToolGuide: (event) => events.push(event) });

    const first = await controller.control(context(library.instructions, library.tools));
    const built = sent.length - 1;

    expect(built).toBeGreaterThan(0);
    expect(events.map((event) => event.type)).toEqual(['built']);
    expect(first.usage).toEqual({ calls: built + 1, inputTokens: 100 * (built + 1), outputTokens: built + 1 });
    expect(actionCriteria(sent)['list_loans']).toContain('[I000] Loans › Look up the member before listing');
    expect(actionCriteria(sent)['respond:completed']).not.toContain('Instructions for this tool');

    const found: Observation = {
      id: 'c1',
      cycle: 1,
      kind: 'tool-result',
      tool: 'find_member',
      summary: 'find_member returned a result.',
      input: { email: 'a@example.org' },
      detail: { member_id: 'm1' },
    };

    const second = await controller.control(context(library.instructions, library.tools, [found]));

    expect(sent.length).toBe(built + 2);
    expect(second.usage).toEqual({ calls: 1, inputTokens: 100, outputTokens: 1 });
    expect(actionCriteria(sent)['list_loans']).toContain('find_member (it has returned a result');

    await controller.control(context(deployment.instructions, deployment.tools));
    expect(events.map((event) => event.type)).toEqual(['built', 'built']);
  });

  test('a failed build leaves selection unchanged and is not retried', async () => {
    const { client, sent } = oracle(library.truth);
    const events: ToolGuideEvent[] = [];

    // SAFETY: the test fixture intentionally models this exact compile-time shape.
    const failing = testFixture<TypeSafeClient>({
      async systemOne(request: Sent) {
        if (!('action' in request.questions)) throw new Error('service unavailable');

        return client.systemOne(testFixture<SystemOneRequest>(request));
      },
    });

    const controller = jev({ client: failing, toolGuide: true, onToolGuide: (event) => events.push(event) });
    const decision = await controller.control(context(library.instructions, library.tools));

    expect(decision.action).toEqual({ type: 'respond', outcome: 'completed' });
    expect(actionCriteria(sent)['list_loans']).not.toContain('Instructions for this tool');

    await controller.control(context(library.instructions, library.tools));
    expect(events).toEqual([
      { type: 'failed', key: expect.any(String), error: 'service unavailable', ms: expect.any(Number) },
    ]);
  });

  test('a cancelled turn stops waiting, and the build still serves the next turn', async () => {
    const { client, sent } = oracle(library.truth);
    let release: () => void = () => {};

    const gate = new Promise<void>((resolve) => (release = resolve));

    // SAFETY: the test fixture intentionally models this exact compile-time shape.
    const slow = testFixture<TypeSafeClient>({
      async systemOne(request: Sent) {
        if (!('action' in request.questions)) await gate;

        return client.systemOne(testFixture<SystemOneRequest>(request));
      },
    });

    const controller = jev({ client: slow, toolGuide: true });
    const cancelled = new AbortController();

    const pending = controller.control(context(library.instructions, library.tools, [], cancelled.signal));
    cancelled.abort(new Error('cancelled'));

    await expect(pending).rejects.toThrow('cancelled');
    release();

    await controller.control(context(library.instructions, library.tools));
    expect(actionCriteria(sent)['renew_loan']).toContain('[I001] Loans › A loan can be renewed at most twice.');
    expect(sent.filter((request) => 'action' in request.questions)).toHaveLength(1);
  });
});
