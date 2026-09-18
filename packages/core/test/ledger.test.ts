import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { annotateRecords, emptyLedger, ledgerFacts, updateLedger, type RequestLedger } from '../src/ledger.ts';
import { stubModel } from '../src/testing.ts';
import type { FactRecord } from '../src/facts.ts';

const ledger: RequestLedger = {
  goals: [{ id: 'change', description: 'Move the ATL→PHL trip to the next day', status: 'open' }],
  slots: [
    { name: 'new_trip.date', value: '2024-05-25', role: 'date of the new outbound flight', source: 'derived', derivation: 'original date 2024-05-24 plus one day' },
    { name: 'selected_flight.flight_number', value: 'HAT110', role: 'flight the user chose', source: 'user' },
  ],
};

describe('request ledger', () => {
  test('slots become facts typed by the kind their name ends in', () => {
    expect(ledgerFacts(ledger)).toEqual([
      {
        type: 'date',
        value: '2024-05-25',
        label: 'date of the new outbound flight (derived: original date 2024-05-24 plus one day; slot new_trip.date)',
        sources: ['ledger'],
      },
      {
        type: 'flight_number',
        value: 'HAT110',
        label: 'flight the user chose (stated by the user; slot selected_flight.flight_number)',
        sources: ['ledger'],
      },
    ]);
  });

  test('records holding a slot value of the same kind are marked with its role', () => {
    const records: FactRecord[] = [
      { fields: { flight_number: 'HAT110', date: '2024-05-25' }, label: 'HAT110 on 2024-05-25', tool: 'search', sources: ['c1'] },
      { fields: { flight_number: 'HAT172', date: '2024-05-26' }, label: 'HAT172 on 2024-05-26', tool: 'search', sources: ['c1'] },
      // Same text, different kind of field: not a match.
      { fields: { reservation_id: 'HAT110', status: 'active' }, label: 'reservation', tool: 'lookup', sources: ['c2'] },
    ];
    const marked = annotateRecords(records, ledger);
    expect(marked[0]!.label).toBe(
      'HAT110 on 2024-05-25 [matches new_trip.date: date of the new outbound flight; selected_flight.flight_number: flight the user chose]',
    );
    expect(marked[1]!.label).toBe('HAT172 on 2024-05-26');
    expect(marked[2]!.label).toBe('reservation');
  });

  test('an update keeps usable slots and drops empty ones', async () => {
    const model = stubModel({
      objects: [{ goals: ledger.goals, slots: [...ledger.slots, { name: 'x.date', value: '', role: 'nothing', source: 'user' }] }],
    });
    const updated = await updateLedger(model, { previous: emptyLedger, transcript: [{ role: 'user', text: 'Move it a day later.' }], newCalls: [] });
    expect(updated.slots.map(slot => slot.name)).toEqual(['new_trip.date', 'selected_flight.flight_number']);
    expect(updated.goals).toEqual(ledger.goals);
  });

  test('when no ledger comes back, the previous one stands', async () => {
    const silent = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: 'not json' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      }),
    });
    expect(await updateLedger(silent, { previous: ledger, transcript: [], newCalls: [] })).toBe(ledger);
  });
});
