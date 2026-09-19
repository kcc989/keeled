import { expect, test } from 'bun:test';
import { schemaReadCandidates, type CandidateTool } from '../src/candidates.ts';
import { reduceState } from '../src/state.ts';
import type { AgentContext } from '../src/tool.ts';
import type { Observation } from '../src/types.ts';

const lookup: CandidateTool = { name: 'inspect_record', risk: 'read', parameters: {
  type: 'object', properties: { record_id: { type: 'string' }, revision: { type: 'integer' } },
  required: ['record_id', 'revision'], additionalProperties: false,
} };
const catalog: CandidateTool[] = [lookup, { name: 'discover', risk: 'read', parameters: {} }, { name: 'edit', risk: 'write', parameters: {} }];
function call(tool: string, detail: unknown, id: string, input: unknown = {}, kind: 'tool-result' | 'tool-error' = 'tool-result'): Observation {
  return { id, tool, input, detail, kind, cycle: 1, summary: 'Observed' };
}
function context(observations: Observation[]): AgentContext {
  return { conversation: [], state: { ...reduceState([]), observations }, abortSignal: new AbortController().signal } as unknown as AgentContext;
}
const build = (observations: Observation[]) => schemaReadCandidates(lookup, catalog)!(context(observations));

test('schema candidates preserve related arguments from each nested record', async () => {
  expect(await build([call('discover', { rows: [{ record_id: 'A', revision: 1, extra: true }, { record_id: 'B', revision: 2 }] }, 'c1')]))
    .toMatchObject([{ input: { record_id: 'A', revision: 1 }, sources: ['c1'] }, { input: { record_id: 'B', revision: 2 }, sources: ['c1'] }]);
});

test('missing, invalid, aliased, and cross-record arguments do not become ready calls', async () => {
  expect(await build([call('discover', { revision: 9, rows: [
    { record_id: 'A' }, { revision: 1 }, { id: 'B', revision: 2 }, { record_id: 'C', revision: 'bad' },
  ] }, 'c1')])).toEqual([]);
});

test('sources merge and successful reads are omitted regardless of property order', async () => {
  const observations = [call('discover', { record_id: 'A', revision: 1 }, 'c1'), call('discover', { revision: 1, record_id: 'A' }, 'c2')];
  expect(await build(observations)).toMatchObject([{ sources: ['c1', 'c2'] }]);
  expect(await build([...observations, call('inspect_record', {}, 'c3', { revision: 1, record_id: 'A' })])).toEqual([]);
});

test('failed mutations and unknown tools invalidate earlier sources', async () => {
  const source = call('discover', { record_id: 'A', revision: 1 }, 'c1');
  expect(await build([source, call('edit', 'Lost response', 'c2', {}, 'tool-error')])).toEqual([]);
  expect(await build([source, call('unclassified', {}, 'c3')])).toEqual([]);
});

test('tool names do not affect candidate generation and mutations cannot offer candidates', async () => {
  const renamed = { ...lookup, name: 'arbitrary_name' };
  const observations = [call('discover', { record_id: 'A', revision: 1 }, 'c1')];
  expect((await schemaReadCandidates(renamed, [...catalog, renamed])!(context(observations)))[0]?.input).toEqual({ record_id: 'A', revision: 1 });
  expect(schemaReadCandidates({ ...lookup, risk: 'write' }, catalog)).toBeUndefined();
});

test('enumeration is bounded and values are copied from evidence', async () => {
  const source = Array.from({ length: 110 }, (_, revision) => ({ record_id: 'A', revision }));
  const result = await build([call('discover', source, 'c1')]);
  expect(result).toHaveLength(100);
  (result[0]!.input as { record_id: string }).record_id = 'changed';
  expect(source[0]!.record_id).toBe('A');
});


test('the same provider handles inventory with a different tool and schema', async () => {
  const inventory: CandidateTool = { name: 'stock_at', risk: 'read', parameters: {
    type: 'object', properties: { sku: { type: 'string' }, warehouse: { type: 'string' } }, required: ['sku', 'warehouse'],
  } };
  const result = await schemaReadCandidates(inventory, [...catalog, inventory])!(context([
    call('discover', { products: [{ sku: 'SKU1', warehouse: 'north' }, { sku: 'SKU2' }] }, 'stock-source'),
  ]));
  expect(result.map(entry => entry.input)).toEqual([{ sku: 'SKU1', warehouse: 'north' }]);
});
