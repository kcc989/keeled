import { z } from 'zod';
import { PlanValidationError } from './errors.ts';

export interface PlanStep<ConditionName extends string = string> {
  id: string;
  objective: string;
  dependencies: string[];
  completion?: ConditionName[];
}

export interface Plan<ConditionName extends string = string> {
  id: string;
  version: number;
  objective: string;
  steps: PlanStep<ConditionName>[];
  completion?: ConditionName[];
}

export const planStepProposalSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'Step ids may contain letters, digits, dot, underscore and dash.'),
  objective: z.string().min(1).max(500),
  dependencies: z.array(z.string()).default([]),
});

export const planProposalSchema = z.object({
  objective: z.string().min(1).max(500),
  steps: z.array(planStepProposalSchema).min(1).max(20),
});

export type PlanProposal = z.infer<typeof planProposalSchema>;

export type StepStatus = 'pending' | 'blocked' | 'active' | 'done' | 'failed';

export function parsePlanProposal(value: unknown): PlanProposal {
  const parsed = planProposalSchema.safeParse(value);
  if (!parsed.success) {
    throw new PlanValidationError(`Plan proposal failed schema validation: ${parsed.error.message}`);
  }
  return validateGraph(parsed.data);
}

function validateGraph(proposal: PlanProposal): PlanProposal {
  const ids = new Set<string>();
  for (const step of proposal.steps) {
    if (ids.has(step.id)) throw new PlanValidationError(`Duplicate step id "${step.id}".`);
    ids.add(step.id);
  }
  for (const step of proposal.steps) {
    for (const dependency of step.dependencies) {
      if (dependency === step.id) {
        throw new PlanValidationError(`Step "${step.id}" depends on itself.`);
      }
      if (!ids.has(dependency)) {
        throw new PlanValidationError(`Step "${step.id}" depends on unknown step "${dependency}".`);
      }
    }
  }
  detectCycle(proposal);
  return proposal;
}

function detectCycle(proposal: PlanProposal): void {
  const byId = new Map(proposal.steps.map(step => [step.id, step]));
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string, trail: string[]): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') {
      throw new PlanValidationError(`Plan contains a dependency cycle: ${[...trail, id].join(' -> ')}`);
    }
    state.set(id, 'visiting');
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      visit(dependency, [...trail, id]);
    }
    state.set(id, 'done');
  };

  for (const step of proposal.steps) visit(step.id, []);
}

export interface PlanAdoption {
  plan: Plan;
  carriedStatuses: Record<string, StepStatus>;
  invalidatedStepIds: string[];
}

export function adoptProposal(
  proposal: PlanProposal,
  previous: { plan: Plan; statuses: Record<string, StepStatus> } | undefined,
  newPlanId: () => string,
): PlanAdoption {
  const plan: Plan = {
    id: previous?.plan.id ?? newPlanId(),
    version: (previous?.plan.version ?? 0) + 1,
    objective: proposal.objective,
    steps: proposal.steps.map(step => ({
      id: step.id,
      objective: step.objective,
      dependencies: [...step.dependencies],
    })),
  };

  const carriedStatuses: Record<string, StepStatus> = {};
  const invalidatedStepIds: string[] = [];

  for (const step of plan.steps) {
    const previousStep = previous?.plan.steps.find(candidate => candidate.id === step.id);
    const previousStatus = previous?.statuses[step.id];
    const unchanged =
      previousStep !== undefined &&
      previousStep.objective === step.objective &&
      sameDependencies(previousStep.dependencies, step.dependencies);

    if (unchanged && previousStatus !== undefined) {
      carriedStatuses[step.id] = previousStatus;
    } else {
      carriedStatuses[step.id] = 'pending';
      invalidatedStepIds.push(step.id);
    }
  }

  for (const previousStep of previous?.plan.steps ?? []) {
    if (!plan.steps.some(step => step.id === previousStep.id)) {
      invalidatedStepIds.push(previousStep.id);
    }
  }

  return { plan, carriedStatuses, invalidatedStepIds };
}

function sameDependencies(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

export function readySteps(plan: Plan, statuses: Record<string, StepStatus>): PlanStep[] {
  return plan.steps.filter(step => {
    const status = statuses[step.id] ?? 'pending';
    if (status === 'done') return false;
    return step.dependencies.every(dependency => (statuses[dependency] ?? 'pending') === 'done');
  });
}

export function dependenciesSatisfied(
  plan: Plan,
  stepId: string,
  statuses: Record<string, StepStatus>,
): boolean {
  const step = plan.steps.find(candidate => candidate.id === stepId);
  if (step === undefined) return false;
  return step.dependencies.every(dependency => (statuses[dependency] ?? 'pending') === 'done');
}
