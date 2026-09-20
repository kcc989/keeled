import { expect, test } from 'bun:test';
import {
  observedReadCandidates,
  observedReadResolver,
  type CandidateTool,
  type ObservedArgumentJudge,
} from '../src/index.ts';
import { reduceState } from '../src/state.ts';
import type { AgentContext } from '../src/tool.ts';
import type { Observation } from '../src/types.ts';
import type { JsonValue } from '../src/json.ts';
import { testFixture } from '../src/testing.ts';

const lookup: CandidateTool = {
  name: 'open_artifact',
  description: 'Open a design artifact by artifact_id.',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: { artifact_id: { type: 'string' } },
    required: ['artifact_id'],
    additionalProperties: false,
  },
};

const catalog: CandidateTool[] = [
  lookup,
  { name: 'list_work', risk: 'read', parameters: {} },
  { name: 'change', risk: 'write', parameters: {} },
];

const observation = (detail: JsonValue, id = 'source', tool = 'list_work', input: JsonValue = {}): Observation => ({
  id,
  tool,
  input,
  detail,
  kind: 'tool-result',
  cycle: 1,
  summary: 'Observed',
});

const context = (observations: Observation[], request = 'Open every canvas.') =>
  // SAFETY: the test fixture intentionally models this exact compile-time shape.
  testFixture<AgentContext>({
    request,
    conversation: [],
    state: { ...reduceState([]), observations },
    abortSignal: new AbortController().signal,
  });

test('a semantic judge selects a dynamic observed domain and code copies every chosen value', async () => {
  const seen: string[] = [];

  const judge: ObservedArgumentJudge = (query) => {
    seen.push(...query.domains.map((domain) => domain.path));
    const domain = query.domains.find((item) => item.path === 'canvases[].tokens[]')!;

    return { domainId: domain.id, optionIds: domain.options.map((option) => option.id) };
  };

  const provider = observedReadCandidates(lookup, catalog, judge)!;
  const result = await provider(context([observation({ canvases: [{ tokens: ['A-1', 'A-2'] }], palettes: ['P-1'] })]));
  expect(seen).toContain('canvases[].tokens[]');
  expect(result.map((candidate) => candidate.input)).toEqual([{ artifact_id: 'A-1' }, { artifact_id: 'A-2' }]);
  expect(result.every((candidate) => candidate.sources[0] === 'source')).toBe(true);
});

test('unknown selections, incompatible values, and write tools produce no candidates', async () => {
  const unknown: ObservedArgumentJudge = () => ({ domainId: 'missing', optionIds: ['missing'] });
  expect(
    await observedReadCandidates(lookup, catalog, unknown)!(context([observation({ rows: [true, 2, null] })])),
  ).toEqual([]);
  expect(observedReadCandidates({ ...lookup, risk: 'write' }, catalog, unknown)).toBeUndefined();
});

test('a mutation invalidates earlier observed values', async () => {
  const all: ObservedArgumentJudge = (query) => ({
    domainId: query.domains[0]?.id,
    optionIds: query.domains[0]?.options.map((option) => option.id) ?? [],
  });

  const provider = observedReadCandidates(lookup, catalog, all)!;
  const observations = [observation({ tokens: ['OLD'] }), observation({ ok: true }, 'mutation', 'change')];
  expect(await provider(context(observations))).toEqual([]);
});

test('root references expose a required observed argument', async () => {
  const referenced: CandidateTool = {
    ...lookup,
    parameters: {
      $ref: '#/$defs/Input',
      $defs: {
        Input: {
          type: 'object',
          properties: { artifact_id: { type: 'string' } },
          required: ['artifact_id'],
          additionalProperties: false,
        },
      },
    },
  };

  const all: ObservedArgumentJudge = (query) => ({
    domainId: query.domains[0]?.id,
    optionIds: query.domains[0]?.options.map((option) => option.id) ?? [],
  });

  const result = await observedReadCandidates(referenced, catalog, all)!(context([observation({ token: 'A-1' })]));
  expect(result.map((candidate) => candidate.input)).toEqual([{ artifact_id: 'A-1' }]);
});

test('selected-tool resolution caches a source relationship and drains every selected member', async () => {
  let judgments = 0;
  const traces: { cacheHit: boolean; path?: string; confidence?: number; selected: unknown[] }[] = [];

  const judge: ObservedArgumentJudge = (query) => {
    judgments++;
    const domain = query.domains.find((item) => item.path === 'canvases[].tokens[]')!;

    return { domainId: domain.id, optionIds: domain.options.map((option) => option.id), sourceConfidence: 0.91 };
  };

  const resolver = observedReadResolver(lookup, catalog, judge, {
    onResolution: (result) =>
      traces.push({
        cacheHit: result.cacheHit,
        path: result.sourcePath,
        confidence: result.sourceConfidence,
        selected: result.selectedOptions.map((option) => option.value),
      }),
  })!;

  const source = observation({ canvases: [{ tokens: ['A-1', 'A-2'] }], palettes: ['P-1'] });

  expect(await resolver(context([source]))).toEqual({ artifact_id: 'A-1' });
  expect(
    await resolver(
      context([source, observation({ title: 'First' }, 'opened-1', 'open_artifact', { artifact_id: 'A-1' })]),
    ),
  ).toEqual({ artifact_id: 'A-2' });
  expect(
    await resolver(
      context([
        source,
        observation({ title: 'First' }, 'opened-1', 'open_artifact', { artifact_id: 'A-1' }),
        observation({ title: 'Second' }, 'opened-2', 'open_artifact', { artifact_id: 'A-2' }),
      ]),
    ),
  ).toBeUndefined();

  expect(judgments).toBe(1);
  expect(traces).toEqual([
    { cacheHit: false, path: 'canvases[].tokens[]', confidence: 0.91, selected: ['A-1', 'A-2'] },
    { cacheHit: true, path: 'canvases[].tokens[]', confidence: 0.91, selected: ['A-1', 'A-2'] },
    { cacheHit: true, path: 'canvases[].tokens[]', confidence: 0.91, selected: ['A-1', 'A-2'] },
  ]);
});

test('a changed source evidence version gets a new judgment after the cached collection drains', async () => {
  let judgments = 0;

  const judge: ObservedArgumentJudge = (query) => {
    judgments++;
    const domain = query.domains.find((item) => item.path === 'tokens[]')!;

    return { domainId: domain.id, optionIds: domain.options.map((option) => option.id) };
  };

  const resolver = observedReadResolver(lookup, catalog, judge)!;
  const first = observation({ tokens: ['A-1'] });
  expect(await resolver(context([first]))).toEqual({ artifact_id: 'A-1' });
  expect(await resolver(context([first]))).toBeUndefined();
  const second = observation({ tokens: ['A-2'] }, 'source-2');
  expect(
    await resolver(
      context([first, observation({ title: 'First' }, 'opened-1', 'open_artifact', { artifact_id: 'A-1' }), second]),
    ),
  ).toEqual({ artifact_id: 'A-2' });
  expect(judgments).toBe(2);
});
