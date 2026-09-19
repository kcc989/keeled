import { z } from 'zod';
import { PlanValidationError } from './errors.ts';

export interface KnownFact {
  id: string;
  statement: string;
  source: 'user' | 'tool' | 'model';
  reference?: string;
}

export interface Goal<ConditionName extends string = string> {
  id: string;
  objective: string;
  /** Kept for compatibility; ordered goals normally depend on all earlier goals. */
  dependencies: string[];
  /** Goal-local constraints, in addition to task constraints. */
  constraints: string[];
  /** The observable outcome that proves this goal is achieved. */
  completionCriteria: string;
  /** Tool-call references attributed to this goal. */
  evidence: string[];
  completion?: ConditionName[];
}

export type TaskStateKind = 'implicit' | 'explicit';

/** Durable task state. Goals are attempted in array order. */
export interface TaskState<ConditionName extends string = string> {
  id: string;
  version: number;
  kind: TaskStateKind;
  objective: string;
  constraints: string[];
  knownFacts: KnownFact[];
  goals: Goal<ConditionName>[];
  /** @deprecated Use goals. This is the same array. */
  steps: Goal<ConditionName>[];
  completion?: ConditionName[];
}

export const goalProposalSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'Goal ids may contain letters, digits, dot, underscore and dash.'),
  objective: z.string().min(1).max(500),
  dependencies: z.array(z.string()).optional(),
  constraints: z.array(z.string().min(1).max(500)).optional(),
  completionCriteria: z.string().min(1).max(800).optional(),
});

export const taskStateProposalSchema = z.object({
  objective: z.string().min(1).max(500),
  constraints: z.array(z.string().min(1).max(500)).optional(),
  knownFacts: z.array(z.string().min(1).max(800)).optional(),
  goals: z.array(goalProposalSchema).min(1).max(20),
});

export type TaskStateProposal = z.infer<typeof taskStateProposalSchema>;

export type GoalStatus = 'pending' | 'active' | 'done' | 'achieved' | 'blocked' | 'failed';

/** Every request starts with one goal without spending a model call. */
export function implicitTaskState(request: string, id: string, factId = 'fact-user-request'): TaskState {
  const goals: Goal[] = [{
    id: 'request',
    objective: request,
    dependencies: [],
    constraints: [],
    completionCriteria: 'The user can be fully answered, or the requested work is complete, without another tool call.',
    evidence: [],
  }];
  return {
    id,
    version: 0,
    kind: 'implicit',
    objective: request,
    constraints: [],
    knownFacts: [{ id: factId, statement: request, source: 'user' }],
    goals,
    steps: goals,
  };
}

export function parseTaskStateProposal(value: unknown): TaskStateProposal {
  const parsed = taskStateProposalSchema.safeParse(value);
  if (!parsed.success) throw new PlanValidationError(`Task-state proposal failed schema validation: ${parsed.error.message}`);
  const goals = parsed.data.goals;
  const ids = new Set<string>();
  for (const goal of goals) {
    if (ids.has(goal.id)) throw new PlanValidationError(`Duplicate goal id "${goal.id}".`);
    ids.add(goal.id);
  }
  return { ...parsed.data, goals };
}

export interface TaskStateAdoption {
  taskState: TaskState;
  carriedStatuses: Record<string, GoalStatus>;
  invalidatedGoalIds: string[];
}

export function adoptTaskStateProposal(
  proposal: TaskStateProposal,
  previous: { taskState: TaskState; statuses: Record<string, GoalStatus> } | undefined,
  newTaskStateId: () => string,
): TaskStateAdoption {
  const goals = proposal.goals.map(goal => ({
    id: goal.id,
    objective: goal.objective,
    dependencies: [...(goal.dependencies ?? [])],
    constraints: [...(goal.constraints ?? [])],
    completionCriteria: goal.completionCriteria ?? 'The goal is achieved and supported by the available evidence.',
    evidence: [],
  }));
  const taskState: TaskState = {
    id: previous?.taskState.id ?? newTaskStateId(),
    version: (previous?.taskState.version ?? 0) + 1,
    kind: 'explicit',
    objective: proposal.objective,
    constraints: [...(proposal.constraints ?? [])],
    knownFacts: mergeFacts(previous?.taskState.knownFacts ?? [], proposal.knownFacts ?? []),
    goals,
    steps: goals,
  };
  const carriedStatuses: Record<string, GoalStatus> = {};
  const invalidatedGoalIds: string[] = [];
  for (const goal of taskState.goals) {
    const old = previous?.taskState.goals.find(candidate => candidate.id === goal.id);
    const oldStatus = previous?.statuses[goal.id];
    if (old !== undefined && oldStatus !== undefined && old.objective === goal.objective && old.completionCriteria === goal.completionCriteria) {
      carriedStatuses[goal.id] = oldStatus;
      goal.evidence = [...old.evidence];
    } else {
      carriedStatuses[goal.id] = 'pending';
      invalidatedGoalIds.push(goal.id);
    }
  }
  for (const old of previous?.taskState.goals ?? []) {
    if (!taskState.goals.some(goal => goal.id === old.id)) invalidatedGoalIds.push(old.id);
  }
  return { taskState, carriedStatuses, invalidatedGoalIds };
}

export function currentGoal(taskState: TaskState, statuses: Record<string, GoalStatus>): Goal | undefined {
  return taskState.goals.find(goal => !['done', 'achieved'].includes(statuses[goal.id] ?? 'pending'));
}

export function addKnownFact(taskState: TaskState | undefined, fact: KnownFact): void {
  if (taskState !== undefined && !taskState.knownFacts.some(existing => existing.id === fact.id)) taskState.knownFacts.push(fact);
}

function mergeFacts(existing: readonly KnownFact[], proposed: readonly string[]): KnownFact[] {
  const result = existing.map(fact => ({ ...fact }));
  for (const statement of proposed) {
    if (!result.some(fact => fact.statement === statement)) {
      result.push({ id: `fact-model-${result.length + 1}`, statement, source: 'model' });
    }
  }
  return result;
}

// Transitional aliases for consumers of the earlier plan API.
export type Plan<C extends string = string> = TaskState<C>;
export type PlanStep<C extends string = string> = Goal<C>;
export type PlanKind = TaskStateKind;
export type PlanProposal = TaskStateProposal;
export type StepStatus = GoalStatus;
export const planStepProposalSchema = goalProposalSchema;
export const planProposalSchema = taskStateProposalSchema;
export const implicitPlan = implicitTaskState;
export const parsePlanProposal = parseTaskStateProposal;
export function adoptProposal(proposal: TaskStateProposal, previous: { plan: TaskState; statuses: Record<string, GoalStatus> } | undefined, newPlanId: () => string) {
  const adopted = adoptTaskStateProposal(proposal, previous === undefined ? undefined : { taskState: previous.plan, statuses: previous.statuses }, newPlanId);
  return { plan: adopted.taskState, carriedStatuses: adopted.carriedStatuses, invalidatedStepIds: adopted.invalidatedGoalIds };
}
export function readySteps(plan: TaskState, statuses: Record<string, GoalStatus>): Goal[] {
  const goal = currentGoal(plan, statuses);
  return goal === undefined ? [] : [goal];
}
export function dependenciesSatisfied(plan: TaskState, goalId: string, statuses: Record<string, GoalStatus>): boolean {
  return currentGoal(plan, statuses)?.id === goalId;
}
