import { expect, test } from 'bun:test';
import { reduceState, type AgentContext, type Observation } from '@keeled/core';
import { airlineReadCandidates } from '../src/candidates.ts';

const risks = new Map<string, string>([
  ['get_user_details', 'read'], ['get_reservation_details', 'read'],
  ['search_direct_flight', 'read'], ['search_onestop_flight', 'read'], ['get_flight_status', 'read'], ['cancel_reservation', 'write'],
]);
function call(tool: string, input: unknown, detail: unknown, id: string): Observation {
  return { id, tool, input, detail, kind: 'tool-result', cycle: 1, summary: 'Result' };
}
function context(observations: Observation[]): AgentContext {
  return { conversation: [], state: { ...reduceState([]), observations } } as unknown as AgentContext;
}

test('new reservations become complete calls and successful reads leave the ready set', () => {
  const calls = [call('get_user_details', {}, { user_id: 'U1', reservations: ['R1', 'R2', 'R1'] }, 'c1')];
  const build = () => airlineReadCandidates('get_reservation_details', context(calls), risks);
  expect(build().map(c => c.input)).toEqual([{ reservation_id: 'R1' }, { reservation_id: 'R2' }]);
  expect(build()[0]!.sources).toEqual(['c1']);
  calls.push(call('get_reservation_details', { reservation_id: 'R1' }, {}, 'c2'));
  expect(build().map(c => c.input)).toEqual([{ reservation_id: 'R2' }]);
  calls.push(call('cancel_reservation', { reservation_id: 'R1' }, {}, 'c3'));
  expect(build()).toEqual([]);
});

test('flight dates stay linked to the source record or search; incomplete records are not ready', () => {
  const calls = [
    call('get_reservation_details', {}, { flights: [{ flight_number: 'F1', date: '2026-10-01' }, { flight_number: 'F2' }] }, 'c1'),
    call('search_direct_flight', { date: '2026-10-02' }, [{ flight_number: 'F3' }], 'c2'),
    call('search_onestop_flight', { date: '2026-10-03' }, [[{ flight_number: 'F4', date: '2026-10-03' }, { flight_number: 'F5', date: '2026-10-04' }]], 'c3'),
    call('unrelated_tool', {}, { flight_number: 'F6', date: '2026-10-04' }, 'c4'),
  ];
  expect(airlineReadCandidates('get_flight_status', context(calls.slice(0, 3)), risks).map(c => c.input)).toEqual([
    { flight_number: 'F1', date: '2026-10-01' }, { flight_number: 'F3', date: '2026-10-02' },
    { flight_number: 'F4', date: '2026-10-03' }, { flight_number: 'F5', date: '2026-10-04' },
  ]);
  expect(airlineReadCandidates('get_flight_status', context(calls), risks)).toEqual([]);
});
