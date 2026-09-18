import { describe, expect, test } from 'bun:test';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import type { Fact } from '@keeled/core';
import { chooseArguments } from '../src/arguments.ts';

const reservations: Fact[] = [
  { type: 'reservation', value: 'M05KNL', label: 'origin=ATL, destination=PHL', sources: ['call_2'] },
  { type: 'reservation', value: 'UHDAHF', label: 'one of reservations returned by get_user_details', sources: ['call_1'] },
];

function client(answer: (key: string) => unknown) {
  const requests: { questions: Record<string, { criteria?: Record<string, string> }> }[] = [];
  const fake = {
    async systemOne(request: (typeof requests)[number]) {
      requests.push(request);
      return {
        answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, answer(key)])),
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
  } as unknown as TypeSafeClient;
  return { fake, requests };
}

const chose = (option: string, confidence = 0.9) => ({ choice: option, confidence, probabilities: { [option]: confidence } });

async function ask(answer: (key: string) => unknown, candidates: readonly Fact[] = reservations) {
  const { fake, requests } = client(answer);
  const picks = await chooseArguments({
    client: fake,
    state: {},
    tool: { name: 'get_reservation_details' },
    parameters: [{ key: 'reservation_id', name: 'reservation_id', candidates }],
  });
  return { pick: picks[0]!, requests };
}

describe('choosing arguments from facts', () => {
  test('a confident pick that is judged listed is used', async () => {
    const { pick, requests } = await ask(key => (key.endsWith('::value') ? chose('M05KNL') : { noul: 0.95 }));
    expect(pick).toMatchObject({ key: 'reservation_id', value: 'M05KNL' });
    expect(pick.abstained).toBeUndefined();
    // One request carries both questions, and the choice always offers a way out.
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions['reservation_id::value']!.criteria!)).toEqual(['M05KNL', 'UHDAHF', 'none']);
  });

  test('choosing none abstains', async () => {
    const { pick } = await ask(key => (key.endsWith('::value') ? chose('none') : { noul: 0.2 }));
    expect(pick).toMatchObject({ abstained: 'chose_none' });
    expect(pick.value).toBeUndefined();
  });

  test('a candidate is not used when the value is judged not listed, however it was chosen', async () => {
    const { pick } = await ask(key => (key.endsWith('::value') ? chose('UHDAHF', 0.8) : { noul: 0.1 }));
    expect(pick).toMatchObject({ abstained: 'not_listed' });
    expect(pick.value).toBeUndefined();
  });

  test('a weak pick abstains', async () => {
    const { pick } = await ask(key => (key.endsWith('::value') ? chose('M05KNL', 0.3) : { noul: 0.95 }));
    expect(pick).toMatchObject({ abstained: 'low_confidence' });
  });

  test('a parameter without candidates abstains without asking', async () => {
    const { pick, requests } = await ask(() => undefined, []);
    expect(pick).toEqual({ key: 'reservation_id', abstained: 'no_candidates' });
    expect(requests).toHaveLength(0);
  });
});

describe('choosing a record for parameters that belong together', () => {
  const flights = [
    { fields: { flight_number: 'HAT110', origin: 'ATL', destination: 'PHL', date: '2024-05-24' }, label: 'HAT110 ATL→PHL 2024-05-24', tool: 'search', sources: ['call_3'] },
    { fields: { flight_number: 'HAT172', origin: 'PHL', destination: 'ATL', date: '2024-05-26' }, label: 'HAT172 PHL→ATL 2024-05-26', tool: 'search', sources: ['call_3'] },
  ];
  const group = {
    key: 'flights.0',
    fields: [
      { key: 'flights.0.flight_number', name: 'flight_number' },
      { key: 'flights.0.date', name: 'date' },
    ],
    records: flights,
  };

  async function askGroup(answer: (key: string) => unknown) {
    const { fake, requests } = client(answer);
    const picks = await chooseArguments({
      client: fake,
      state: {},
      tool: { name: 'update_reservation_flights' },
      parameters: [],
      groups: [group],
    });
    return { picks, requests };
  }

  test('every field comes from the one chosen record', async () => {
    const { picks, requests } = await askGroup(key => (key.endsWith('::record') ? chose('record_2') : { noul: 0.9 }));
    expect(picks.map(pick => [pick.key, pick.value])).toEqual([
      ['flights.0.flight_number', 'HAT172'],
      ['flights.0.date', '2024-05-26'],
    ]);
    expect(Object.keys(requests[0]!.questions['flights.0::record']!.criteria!)).toEqual(['record_1', 'record_2', 'none']);
  });

  test('declining the records leaves every field to the model', async () => {
    const none = await askGroup(key => (key.endsWith('::record') ? chose('none') : { noul: 0.1 }));
    expect(none.picks.map(pick => pick.abstained)).toEqual(['chose_none', 'chose_none']);
    const unlisted = await askGroup(key => (key.endsWith('::record') ? chose('record_1') : { noul: 0.1 }));
    expect(unlisted.picks.map(pick => pick.abstained)).toEqual(['not_listed', 'not_listed']);
    expect(unlisted.picks.every(pick => pick.value === undefined)).toBe(true);
  });
});
