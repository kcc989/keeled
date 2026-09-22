import { expect, test } from 'bun:test';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import { testFixture } from '@keeled/core/testing';
import { jev } from '../src/controller.ts';
import type { FactJudgmentRequest, JsonObject } from '@keeled/core';

test('normal Jev supplies independent relevance and contradiction questions over real candidates', async () => {
  const requests: Array<{ state: JsonObject; questions: JsonObject }> = [];

  const client = testFixture<TypeSafeClient>({
    systemOne: async (request: (typeof requests)[number]) => {
      requests.push(request);

      return {
        answers: {
          relevant_0: { noul: 0.9 },
          conflict_0: { noul: 0.1 },
          relevant_1: { noul: 0.1 },
          conflict_1: { noul: 0.8 },
        },
        usage: { input_tokens: 100, output_tokens: 4 },
      };
    },
  });

  const candidate = (id: string, value: string): FactJudgmentRequest['candidates'][number] => ({
    fact: {
      id,
      revision: 1,
      kind: 'passage',
      value,
      origin: 'observed',
      status: 'active',
      sources: [{ sourceId: 'source', sourceVersion: 'v1', location: { start: 0, end: value.length } }],
    },
    source: { id: 'source', version: 'v1', role: 'tool', authority: 'observation', order: 1 },
  });

  const candidates = [
    candidate('first', 'There are two available copies.'),
    candidate('second', 'The requested copy is sealed.'),
  ];

  const result = await jev({ client }).judgeFacts!({
    question: 'Which copy can be moved?',
    candidates,
    abortSignal: new AbortController().signal,
  });

  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0]!.state['candidates'])).toBe(JSON.stringify(candidates));
  expect(Object.keys(requests[0]!.questions)).toEqual([
    'exhaustive',
    'relevant_0',
    'conflict_0',
    'relevant_1',
    'conflict_1',
  ]);
  expect(JSON.stringify(requests[0]!.questions['relevant_0'])).toContain('candidates[0]');
  expect(result.judgments).toEqual([
    { id: 'first', relevant: 0.9, contradicts: 0.1 },
    { id: 'second', relevant: 0.1, contradicts: 0.8 },
  ]);
  expect(result.usage).toEqual({ calls: 1, inputTokens: 100, outputTokens: 4 });
});

function facts(count: number, value = 'A sample is available.'): FactJudgmentRequest['candidates'] {
  return Array.from({ length: count }, (_, index) => ({
    fact: {
      id: `fact-${index}`,
      revision: 1,
      kind: 'passage',
      value,
      origin: 'observed',
      status: 'active',
      sources: [{ sourceId: `source-${index}`, sourceVersion: 'v1', location: { start: 0, end: value.length } }],
    },
    source: { id: `source-${index}`, version: 'v1', role: 'tool', authority: 'observation', order: index },
  }));
}

type Batch = { state: JsonObject; questions: JsonObject };

function batchCandidates(request: Batch): FactJudgmentRequest['candidates'] {
  return testFixture<FactJudgmentRequest['candidates']>(request.state['candidates'] ?? []);
}

type NoulAnswers = Record<string, { noul: number }>;

function answersFor(request: Batch, scope = 0.1) {
  const answers: NoulAnswers = {};

  answers['exhaustive'] = { noul: scope };
  batchCandidates(request).forEach((_, index) => {
    answers[`relevant_${index}`] = { noul: 0.9 };
    answers[`conflict_${index}`] = { noul: 0.1 };
  });

  return { answers, usage: { input_tokens: 100, output_tokens: 4 } };
}

function limitError() {
  return Object.assign(new Error('token limit'), {
    status: 400,
    body: { detail: { error_type: 'max_tokens_exceeded' } },
  });
}

test('token-limit retries split candidates, preserve order and sum usage', async () => {
  const requests: Batch[] = [];

  const client = testFixture<TypeSafeClient>({
    systemOne: async (request: Batch) => {
      requests.push(request);

      if (batchCandidates(request).length > 1) throw limitError();

      return answersFor(request, batchCandidates(request)[0]!.fact.id === 'fact-2' ? 0.8 : 0.1);
    },
  });

  const candidates = facts(4);

  const result = await jev({ client }).judgeFacts!({
    question: 'Which sample is available?',
    candidates,
    abortSignal: new AbortController().signal,
  });

  expect(requests.map((r) => batchCandidates(r).length)).toEqual([4, 2, 1, 1, 2, 1, 1]);
  expect(result.judgments.map((j) => j.id)).toEqual(candidates.map((c) => c.fact.id));
  expect(requests.filter((r) => batchCandidates(r).length === 1).flatMap((r) => batchCandidates(r))).toEqual(
    candidates,
  );
  expect(result.requiresCompleteScope).toBe(0.8);
  expect(result.usage).toEqual({ calls: 7, inputTokens: 400, outputTokens: 16 });
});

test('large UTF-8 payload is split proactively with exact source metadata', async () => {
  const requests: Batch[] = [];
  const candidates = facts(8, '部品'.repeat(900));

  const client = testFixture<TypeSafeClient>({
    systemOne: async (request: Batch) => {
      requests.push(request);

      return answersFor(request);
    },
  });

  const result = await jev({ client }).judgeFacts!({
    question: 'Find available parts.',
    candidates,
    abortSignal: new AbortController().signal,
  });

  expect(requests.length).toBeGreaterThan(1);
  expect(requests.flatMap((r) => batchCandidates(r))).toEqual(candidates);
  expect(result.judgments).toHaveLength(8);
  expect(result.usage!.calls).toBe(requests.length);
});

test('single oversized fact and unrelated errors fail without repeated requests', async () => {
  for (const error of [
    limitError(),
    Object.assign(new Error('unavailable'), { status: 503 }),
    new Error('max_tokens_exceeded'),
  ]) {
    let calls = 0;

    const client = testFixture<TypeSafeClient>({
      systemOne: async () => {
        calls++;
        throw error;
      },
    });

    await expect(
      jev({ client }).judgeFacts!({
        question: 'Find a sample.',
        candidates: facts(error.message === 'token limit' ? 1 : 4),
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
  }
});

test('abort stops token-limit splitting', async () => {
  const abort = new AbortController();
  let calls = 0;

  const client = testFixture<TypeSafeClient>({
    systemOne: async () => {
      calls++;
      abort.abort();
      throw limitError();
    },
  });

  await expect(
    jev({ client }).judgeFacts!({ question: 'Find parts.', candidates: facts(4), abortSignal: abort.signal }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

test('missing or invalid scope judgment cannot become a complete negative across batches', async () => {
  for (const scope of [undefined, -1]) {
    const client = testFixture<TypeSafeClient>({
      systemOne: async (request: Batch) => {
        if (batchCandidates(request).length > 1) throw limitError();
        const response = answersFor(request);

        if (batchCandidates(request)[0]!.fact.id === 'fact-0') {
          if (scope === undefined) delete response.answers['exhaustive'];
          else response.answers['exhaustive'] = { noul: scope };
        }

        return response;
      },
    });

    const result = await jev({ client }).judgeFacts!({
      question: 'Find parts.',
      candidates: facts(2),
      abortSignal: new AbortController().signal,
    });

    if (scope === undefined) expect(result.requiresCompleteScope).toBeUndefined();
    else expect(result.requiresCompleteScope).toBeNaN();
  }
});
