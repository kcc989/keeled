import type { Plan, StepStatus } from './plan.ts';
import type {
  AgentMessage,
  BlockerRecord,
  DecisionRecord,
  ExecutionState,
  Observation,
  PlanRecord,
  TransitionRecord,
  VerificationRecord,
} from './types.ts';

export const reducerVersion = 1;

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
 * Only the parts written after the last terminal transition are reduced, so that
 * state describes the current turn rather than the whole conversation. It never
 * re-runs the controller, tools, or acceptance callbacks.
 */
export function reduceState(messages: readonly AgentMessage[]): ExecutionState {
  const parts: AgentMessage['parts'] = [];
  let stopReason: ExecutionState['stopReason'];

  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    parts.push(...message.parts);
  }

  let start = 0;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type === 'data-transition') {
      const record = (part as { data: TransitionRecord }).data;
      if (record.stopReason !== undefined) {
        start = index + 1;
        stopReason = record.stopReason;
        break;
      }
    }
  }

  const state = emptyState();
  const context: ReduceContext = {};
  for (const part of parts.slice(start)) {
    applyPart(state, part, context);
  }
  if (start > 0 && start === parts.length) state.stopReason = stopReason;
  return state;
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
    context.tool = record.action.type === 'tool' ? record.action.tool : undefined;
    context.stepId = record.action.type === 'tool' ? record.action.stepId : undefined;
    return;
  }

  if (type === 'data-plan') {
    const record = (part as { data: PlanRecord }).data;
    const plan: Plan = {
      id: record.planId,
      version: record.version,
      objective: record.objective,
      steps: record.steps.map(step => ({ ...step, dependencies: [...step.dependencies] })),
    };
    state.plan = plan;
    state.planRevisions = record.version;
    state.stepStatuses = { ...record.carriedStatuses };
    for (const stepId of record.invalidatedStepIds) {
      delete state.verification[stepId];
    }
    for (const stepId of Object.keys(state.verification)) {
      if (!plan.steps.some(step => step.id === stepId)) delete state.verification[stepId];
    }
    state.goal = undefined;
    state.observations.push({
      id: record.id,
      cycle: record.cycle,
      kind: 'plan',
      summary: `Plan revision ${record.version}: ${record.objective}`,
      detail: { steps: record.steps.map(step => step.id) },
    });
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
  }
}

export function statusesFor(plan: Plan | undefined, statuses: Record<string, StepStatus>): Record<string, StepStatus> {
  if (plan === undefined) return {};
  const result: Record<string, StepStatus> = {};
  for (const step of plan.steps) {
    result[step.id] = statuses[step.id] ?? 'pending';
  }
  return result;
}
