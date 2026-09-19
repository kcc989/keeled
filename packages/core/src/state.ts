import type { Plan, StepStatus } from './plan.ts';
import type {
  AgentMessage,
  BlockerRecord,
  DecisionRecord,
  ExecutionState,
  KnownFactRecord,
  Observation,
  PlanRecord,
  TransitionRecord,
  VerificationRecord,
} from './types.ts';

export const reducerVersion = 2;

export function emptyState(): ExecutionState {
  return {
    reducerVersion,
    cycle: 0,
    stepsUsed: 0,
    planRevisions: 0,
    stepStatuses: {},
    verification: {},
    observations: [],
    blockers: [],
    toolCalls: 0,
  };
}

/**
 * Pure, versioned reduction of persisted message data into execution state.
 *
 * Terminal transitions reset turn-local execution state. A task waiting for user input
 * also retains its plan and progress. It never re-runs the controller, tools, or callbacks.
 */
export function reduceState(messages: readonly AgentMessage[]): ExecutionState {
  let state = emptyState();
  const context: ReduceContext = {};
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      applyPart(state, part, context);
      if (part.type === 'data-transition') {
        const record = (part as { data: TransitionRecord }).data;
        if (record.stopReason !== undefined) {
          state = nextTurnState(state, record.stopReason === 'needs_input');
          delete context.tool;
          delete context.stepId;
        }
      }
    }
  }
  return state;
}

/** Carry a waiting task into its reply turn; otherwise begin with no active task. */
function nextTurnState(completed: ExecutionState, taskIsWaiting: boolean): ExecutionState {
  const next = emptyState();
  next.stopReason = completed.stopReason;
  if (taskIsWaiting) {
    next.planRevisions = completed.planRevisions;
    next.stepStatuses = { ...completed.stepStatuses };
    next.verification = { ...completed.verification };
  }
  if (taskIsWaiting && completed.plan !== undefined) {
    const goals = completed.plan.goals.map(goal => ({
      ...goal,
      dependencies: [...goal.dependencies],
      constraints: [...goal.constraints],
      evidence: [...goal.evidence],
    }));
    next.plan = {
      ...completed.plan,
      constraints: [...completed.plan.constraints],
      knownFacts: completed.plan.knownFacts.map(fact => ({ ...fact })),
      goals,
      steps: goals,
    };
    next.taskState = next.plan;
  }
  return next;
}

/** The decision currently in effect, which attributes the tool parts that follow it. */
interface ReduceContext {
  tool?: string;
  stepId?: string;
}

function applyPart(
  state: ExecutionState,
  part: AgentMessage['parts'][number],
  context: ReduceContext,
): void {
  const type = part.type;

  if (type === 'data-decision') {
    const record = (part as { data: DecisionRecord }).data;
    state.cycle = Math.max(state.cycle, record.cycle);
    state.stepsUsed += 1;
    delete state.stopReason;
    context.tool = record.action.type === 'tool' ? record.action.tool : undefined;
    context.stepId = record.action.type === 'tool' ? record.action.stepId : undefined;
    return;
  }

  if (type === 'data-plan') {
    const record = (part as { data: PlanRecord }).data;
    const goals = record.steps.map(step => ({
      ...step,
      dependencies: [...step.dependencies],
      constraints: [...step.constraints],
      evidence: [...step.evidence],
    }));
    const plan: Plan = {
      id: record.planId,
      version: record.version,
      kind: record.kind,
      objective: record.objective,
      constraints: [...(record.constraints ?? [])],
      knownFacts: (record.knownFacts ?? []).map(fact => ({ ...fact })),
      goals,
      steps: goals,
    };
    state.plan = plan;
    state.taskState = plan;
    state.planRevisions = record.version;
    state.stepStatuses = { ...record.carriedStatuses };
    for (const stepId of record.invalidatedStepIds) {
      delete state.verification[stepId];
    }
    for (const stepId of Object.keys(state.verification)) {
      if (!plan.steps.some(step => step.id === stepId)) delete state.verification[stepId];
    }
    state.observations.push({
      id: record.id,
      cycle: record.cycle,
      kind: 'plan',
      summary: `Plan revision ${record.version}: ${record.objective}`,
      detail: { steps: record.steps.map(step => step.id) },
    });
    return;
  }

  if (type === 'data-fact') {
    const record = (part as { data: KnownFactRecord }).data;
    const taskState = state.taskState ?? state.plan;
    if (taskState !== undefined && !taskState.knownFacts.some(fact => fact.id === record.fact.id)) {
      taskState.knownFacts.push({ ...record.fact });
    }
    return;
  }

  if (type === 'data-verification') {
    const record = (part as { data: VerificationRecord }).data;
    for (const [stepId, verification] of Object.entries(record.summary.steps)) {
      // `unknown` reports absent evidence, not a failure, so it never overwrites a
      // recorded result. Only a `failed` result or a plan revision regresses a step.
      if (verification.outcome === 'unknown' && state.verification[stepId] !== undefined) continue;
      state.verification[stepId] = verification;
      if (verification.outcome === 'passed') {
        state.stepStatuses[stepId] = 'done';
      } else if (verification.outcome === 'failed' && state.stepStatuses[stepId] === 'done') {
        state.stepStatuses[stepId] = 'pending';
      }
    }
    if (!(record.summary.goal.outcome === 'unknown' && state.goal !== undefined)) {
      state.goal = record.summary.goal;
    }
    return;
  }

  if (type === 'data-blocker') {
    const record = (part as { data: BlockerRecord }).data;
    state.blockers.push(record);
    state.observations.push({
      id: record.id,
      cycle: record.cycle,
      kind: 'blocked',
      tool: record.tool,
      stepId: record.stepId,
      summary: record.reason,
    });
    return;
  }

  if (type === 'data-transition') {
    const record = (part as { data: TransitionRecord }).data;
    if (record.stopReason !== undefined) state.stopReason = record.stopReason;
    return;
  }

  if (type.startsWith('tool-') || type === 'dynamic-tool') {
    applyToolPart(state, part as ToolPartLike, context);
  }
}

interface ToolPartLike {
  type: string;
  toolCallId: string;
  toolName?: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

function applyToolPart(state: ExecutionState, part: ToolPartLike, context: ReduceContext): void {
  const toolName =
    part.toolName ??
    (part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : context.tool) ??
    'unknown';
  // The step comes from the decision that selected this call, never from its output.
  const stepId = context.stepId;

  if (part.state === 'output-available') {
    state.toolCalls += 1;
    state.observations.push({
      id: part.toolCallId,
      cycle: state.cycle,
      kind: 'tool-result',
      tool: toolName,
      stepId,
      summary: `${toolName} returned a result.`,
      input: part.input,
      detail: part.output,
    });
    attachEvidence(state.plan, stepId, part.toolCallId);
    attachToolFact(state.plan, toolName, part.toolCallId);
    return;
  }

  if (part.state === 'output-error') {
    state.toolCalls += 1;
    const observation: Observation = {
      id: part.toolCallId,
      cycle: state.cycle,
      kind: 'tool-error',
      tool: toolName,
      stepId,
      summary: part.errorText ?? `${toolName} failed.`,
      input: part.input,
      detail: part.input,
    };
    state.observations.push(observation);
    attachEvidence(state.plan, stepId, part.toolCallId);
  }
}

function attachToolFact(plan: Plan | undefined, tool: string, ref: string): void {
  if (plan === undefined || plan.knownFacts.some(fact => fact.id === `fact-${ref}`)) return;
  plan.knownFacts.push({
    id: `fact-${ref}`,
    statement: `${tool} returned evidence in ${ref}.`,
    source: 'tool',
    reference: ref,
  });
}

function attachEvidence(plan: Plan | undefined, stepId: string | undefined, ref: string): void {
  if (plan === undefined || stepId === undefined) return;
  const step = plan.steps.find(candidate => candidate.id === stepId);
  if (step !== undefined && !step.evidence.includes(ref)) step.evidence.push(ref);
}

export function statusesFor(plan: Plan | undefined, statuses: Record<string, StepStatus>): Record<string, StepStatus> {
  if (plan === undefined) return {};
  const result: Record<string, StepStatus> = {};
  for (const step of plan.steps) {
    result[step.id] = statuses[step.id] ?? 'pending';
  }
  return result;
}
