import { describe, expect, test } from 'bun:test';
import { adoptTaskStateProposal, currentGoal, parseTaskStateProposal } from '../src/plan.ts';

const base = {
  objective: 'Ship the change',
  constraints: ['Keep the public API stable'],
  knownFacts: ['The helper is exported.'],
  goals: [
    { id: 'locate', objective: 'Locate the file', dependencies: [], constraints: [] },
    { id: 'edit', objective: 'Apply the edit', dependencies: [], constraints: [] },
  ],
};

describe('task state', () => {
  test('accepts ordered goals, constraints, and facts', () => {
    const proposal = parseTaskStateProposal(base);
    expect(proposal.goals.map(goal => goal.id)).toEqual(['locate', 'edit']);
    expect(proposal.constraints).toEqual(['Keep the public API stable']);
    expect(proposal.knownFacts).toEqual(['The helper is exported.']);
  });

  test('rejects duplicate goal ids', () => {
    expect(() => parseTaskStateProposal({ ...base, goals: [base.goals[0], base.goals[0]] })).toThrow(/Duplicate goal id/);
  });

  test('preserves achieved goals when new goals are added', () => {
    const first = adoptTaskStateProposal(parseTaskStateProposal(base), undefined, () => 'task-1');
    const revised = adoptTaskStateProposal(
      parseTaskStateProposal({
        ...base,
        knownFacts: [...base.knownFacts, 'The user also requested tests.'],
        goals: [...base.goals, { id: 'verify', objective: 'Run tests', dependencies: [], constraints: [] }],
      }),
      { taskState: first.taskState, statuses: { locate: 'done', edit: 'pending' } },
      () => 'task-2',
    );

    expect(revised.taskState.id).toBe('task-1');
    expect(revised.taskState.version).toBe(2);
    expect(revised.carriedStatuses).toMatchObject({ locate: 'done', edit: 'pending', verify: 'pending' });
    expect(revised.invalidatedGoalIds).toEqual(['verify']);
  });

  test('selects the first goal that is not achieved', () => {
    const state = adoptTaskStateProposal(parseTaskStateProposal(base), undefined, () => 'task-1').taskState;
    expect(currentGoal(state, { locate: 'pending', edit: 'pending' })?.id).toBe('locate');
    expect(currentGoal(state, { locate: 'done', edit: 'pending' })?.id).toBe('edit');
  });
});
