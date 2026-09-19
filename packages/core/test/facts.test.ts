import { describe, expect, test } from 'bun:test';
import { candidatesFor, factIndex, factType } from '../src/facts.ts';
import type { CallRecord } from '../src/projection.ts';

const call = (ref: string, tool: string, result: unknown): CallRecord => ({
  ref,
  turn: 'current',
  tool,
  input: {},
  outcome: 'result',
  result,
});

const user = call('call_1', 'get_user_details', {
  user_id: 'aarav_garcia_1177',
  membership: 'silver',
  payment_methods: {
    gift_card_8887175: { source: 'gift_card', amount: 150, id: 'gift_card_8887175' },
  },
  documents: ['M05KNL', 'UHDAHF'],
});
const document = call('call_2', 'get_document_details', {
  document_id: 'M05KNL',
  workspace: 'OPS',
  folder: 'ENG',
  tier: 'standard',
});

describe('fact types', () => {
  test('names for one kind of value agree', () => {
    expect(factType('document_id')).toBe('document');
    expect(factType('documents')).toBe('document');
    expect(factType('payment_methods')).toBe('payment_method');
    expect(factType('payment_id')).toBe('payment');
    expect(factType('item_number')).toBe('item_number');
    expect(factType('status')).toBe('status');
  });
});

describe('fact index', () => {
  const facts = factIndex([user, document], [{ text: 'My user id is aarav_garcia_1177, working OPS on 2024-05-24.' }]);

  test('one fact per value, with every source and the most descriptive label', () => {
    const m05 = facts.filter(fact => fact.value === 'M05KNL');
    expect(m05).toHaveLength(1);
    expect(m05[0]).toMatchObject({ type: 'document', sources: ['call_1', 'call_2'] });
    expect(m05[0]!.label).toContain('workspace=OPS, folder=ENG');
    expect(facts.find(fact => fact.value === 'UHDAHF')?.label).toBe('one of documents returned by get_user_details');
  });

  test('an id takes the name of the collection it belongs to', () => {
    expect(facts.find(fact => fact.value === 'gift_card_8887175' && fact.type === 'payment_method')).toBeDefined();
  });

  test('values the user wrote are indexed as mentions', () => {
    const mentioned = facts.filter(fact => fact.type === 'mentioned').map(fact => fact.value);
    expect(mentioned).toEqual(expect.arrayContaining(['aarav_garcia_1177', 'OPS', '2024-05-24']));
  });

  test('candidates are ranked by how closely their type matches the parameter', () => {
    const documents = candidatesFor('document_id', facts).map(fact => fact.value);
    expect(documents.slice(0, 2)).toEqual(['M05KNL', 'UHDAHF']);
    expect(candidatesFor('payment_id', facts).map(fact => fact.value)).toContain('gift_card_8887175');
  });
});
