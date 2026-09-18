import { describe, expect, test } from 'bun:test';
import { adoptProposal, parsePlanProposal, readySteps } from '../src/plan.ts';

const base = {
  objective: 'Ship the change',
  steps: [
    { id: 's1', objective: 'Locate the file', dependencies: [] },
    { id: 's2', objective: 'Apply the edit', dependencies: ['s1'] },
  ],
};

describe('parsePlanProposal', () => {
  test('accepts a valid proposal', () => {
    expect(parsePlanProposal(base).steps).toHaveLength(2);
  });

  test('rejects duplicate step ids', () => {
    expect(() =>
      parsePlanProposal({ ...base, steps: [base.steps[0], base.steps[0]] }),
    ).toThrow(/Duplicate step id/);
  });

  test('rejects unknown dependencies', () => {
    expect(() =>
      parsePlanProposal({ ...base, steps: [{ id: 'a', objective: 'x', dependencies: ['ghost'] }] }),
    ).toThrow(/unknown step/);
  });

  test('rejects dependency cycles', () => {
    expect(() =>
      parsePlanProposal({
        objective: 'x',
        steps: [
          { id: 'a', objective: 'a', dependencies: ['b'] },
          { id: 'b', objective: 'b', dependencies: ['a'] },
        ],
      }),
    ).toThrow(/cycle/);
  });
});

describe('adoptProposal', () => {
  test('assigns revision 1 for a first plan', () => {
    const adoption = adoptProposal(parsePlanProposal(base), undefined, () => 'plan-1');
    expect(adoption.plan.version).toBe(1);
    expect(adoption.plan.id).toBe('plan-1');
  });

  test('keeps status for unchanged steps and invalidates changed ones', () => {
    const first = adoptProposal(parsePlanProposal(base), undefined, () => 'plan-1');
    const revised = adoptProposal(
      parsePlanProposal({
        objective: 'Ship the change',
        steps: [
          { id: 's1', objective: 'Locate the file', dependencies: [] },
          { id: 's2', objective: 'Apply a different edit', dependencies: ['s1'] },
        ],
      }),
      { plan: first.plan, statuses: { s1: 'done', s2: 'failed' } },
      () => 'plan-2',
    );

    expect(revised.plan.id).toBe('plan-1');
    expect(revised.plan.version).toBe(2);
    expect(revised.carriedStatuses['s1']).toBe('done');
    expect(revised.carriedStatuses['s2']).toBe('pending');
    expect(revised.invalidatedStepIds).toEqual(['s2']);
  });
});

describe('readySteps', () => {
  test('returns only steps whose dependencies are done', () => {
    const plan = adoptProposal(parsePlanProposal(base), undefined, () => 'plan-1').plan;
    expect(readySteps(plan, { s1: 'pending', s2: 'pending' }).map(s => s.id)).toEqual(['s1']);
    expect(readySteps(plan, { s1: 'done', s2: 'pending' }).map(s => s.id)).toEqual(['s2']);
  });
});
