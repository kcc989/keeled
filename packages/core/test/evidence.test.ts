import { describe, expect, test } from 'bun:test';
import { evidenceTool } from '../src/evidence.ts';
import { callHistory } from '../src/projection.ts';
import { reduceState } from '../src/state.ts';
import type { AgentToolExecutionOptions } from '../src/tool.ts';
import type { AgentMessage } from '../src/types.ts';
import type { JsonValue } from '../src/json.ts';

function toolMessage(id: string, tool: string, input: JsonValue, output: JsonValue): AgentMessage {
  return {
    id: `m-${id}`,
    role: 'assistant',
    // SAFETY: the test fixture intentionally models this exact compile-time shape.
    parts: [{ type: `tool-${tool}`, toolCallId: id, state: 'output-available', input, output } as never],
  };
}

const component = (item: string, premium: number | undefined) => ({
  item_number: item,
  prices: premium === undefined ? { standard: 100 } : { standard: 100, premium },
});

// Product bundles: each record is a pair of components.
const bundles = [
  [component('SKU1', 500), component('SKU2', 400)],
  [component('SKU3', 300), component('SKU4', 250)],
  [component('SKU5', undefined), component('SKU6', 100)],
  [component('SKU7', 200), component('SKU8', 450)],
];

function run(input: Parameters<ReturnType<typeof evidenceTool>['execute']>[0], conversation: AgentMessage[]) {
  // SAFETY: the test fixture intentionally models this exact compile-time shape.
  const options = { conversation, state: reduceState([]) } as AgentToolExecutionOptions;

  return evidenceTool().execute(input, options);
}

describe('call history', () => {
  test('a call in the message being written appears once, as current', () => {
    const current = toolMessage('call_1', 'get_users', {}, [{ user_id: 'u1' }]);
    const state = reduceState([current]);
    const history = callHistory([current], state.observations);
    expect(history.map((call) => [call.ref, call.turn])).toEqual([['call_1', 'current']]);
  });

  test('earlier calls keep their references', () => {
    const earlier = toolMessage('call_0', 'get_users', {}, []);
    expect(callHistory([earlier], []).map((call) => [call.ref, call.turn])).toEqual([['call_0', 'earlier']]);
  });
});

describe('evidence tool', () => {
  const conversation = [toolMessage('call_7', 'search_bundles', { workspace: 'HQ1' }, bundles)];

  test('sorts the full result, summing across components, with missing keys last', async () => {
    const page = await run({ ref: 'call_7', sortBy: '[].prices.premium' }, conversation);
    expect(page.records.map((entry) => [entry.index, entry.sortValue])).toEqual([
      [1, 550],
      [3, 650],
      [0, 900],
      [2, null],
    ]);
    // Records come back whole.
    expect(page.records[0]?.record).toEqual(bundles[1]);
  });

  test('pages complete records', async () => {
    const second = await run({ ref: 'call_7', page: 2, pageSize: 3 }, conversation);
    expect(second).toMatchObject({ total: 4, page: 2, pages: 2, pageSize: 3 });
    expect(second.records).toEqual([{ index: 3, record: bundles[3] }]);
  });

  test('an unknown reference is an error, not an empty page', async () => {
    await expect(Promise.resolve().then(() => run({ ref: 'call_404' }, conversation))).rejects.toThrow(
      'No tool result has the reference "call_404".',
    );
  });
});
