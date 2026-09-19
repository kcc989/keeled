import { describe, expect, test } from 'bun:test';
import { evidenceTool } from '../src/evidence.ts';
import { callHistory } from '../src/projection.ts';
import { reduceState } from '../src/state.ts';
import type { AgentToolExecutionOptions } from '../src/tool.ts';
import type { AgentMessage } from '../src/types.ts';

function toolMessage(id: string, tool: string, input: unknown, output: unknown): AgentMessage {
  return {
    id: `m-${id}`,
    role: 'assistant',
    parts: [{ type: `tool-${tool}`, toolCallId: id, state: 'output-available', input, output } as never],
  };
}

const leg = (flight: string, business: number | undefined) => ({
  flight_number: flight,
  prices: business === undefined ? { economy: 100 } : { economy: 100, business },
});

// Connecting itineraries: each record is a pair of legs.
const itineraries = [
  [leg('HAT1', 500), leg('HAT2', 400)],
  [leg('HAT3', 300), leg('HAT4', 250)],
  [leg('HAT5', undefined), leg('HAT6', 100)],
  [leg('HAT7', 200), leg('HAT8', 450)],
];

function run(input: Parameters<ReturnType<typeof evidenceTool>['execute']>[0], conversation: AgentMessage[]) {
  const options = { conversation, state: reduceState([]) } as unknown as AgentToolExecutionOptions;
  return evidenceTool().execute(input, options);
}

describe('call history', () => {
  test('a call in the message being written appears once, as current', () => {
    const current = toolMessage('call_1', 'get_users', {}, [{ user_id: 'u1' }]);
    const state = reduceState([current]);
    const history = callHistory([current], state.observations);
    expect(history.map(call => [call.ref, call.turn])).toEqual([['call_1', 'current']]);
  });

  test('earlier calls keep their references', () => {
    const earlier = toolMessage('call_0', 'get_users', {}, []);
    expect(callHistory([earlier], []).map(call => [call.ref, call.turn])).toEqual([['call_0', 'earlier']]);
  });
});

describe('evidence tool', () => {
  const conversation = [toolMessage('call_7', 'search_onestop_flight', { origin: 'JFK' }, itineraries)];

  test('sorts the full result, summing across legs, with missing keys last', async () => {
    const page = await run({ ref: 'call_7', sortBy: '[].prices.business' }, conversation);
    expect(page.records.map(entry => [entry.index, entry.sortValue])).toEqual([
      [1, 550],
      [3, 650],
      [0, 900],
      [2, null],
    ]);
    // Records come back whole.
    expect(page.records[0]?.record).toEqual(itineraries[1]);
  });

  test('pages complete records', async () => {
    const second = await run({ ref: 'call_7', page: 2, pageSize: 3 }, conversation);
    expect(second).toMatchObject({ total: 4, page: 2, pages: 2, pageSize: 3 });
    expect(second.records).toEqual([{ index: 3, record: itineraries[3] }]);
  });

  test('an unknown reference is an error, not an empty page', async () => {
    await expect(Promise.resolve().then(() => run({ ref: 'call_404' }, conversation))).rejects.toThrow(
      'No tool result has the reference "call_404".',
    );
  });
});
