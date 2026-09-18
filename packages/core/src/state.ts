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
  for (const part of parts.slice(start)) {
    applyPart(state, part);
  }
  if (start > 0 && start === parts.length) state.stopReason = stopReason;
  return state;
}

function applyPart(state: ExecutionState, part: AgentMessage['parts'][number]): void {
  const type = part.type;

  if (type === 'data-decision') {
    const record = (part as { data: DecisionRecord }).data;
    state.cycle = Math.max(state.cycle, record.cycle);
    state.stepsUsed += 1;
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
      state.verification[stepId] = verification;
      if (verification.outcome === 'passed') {
        state.stepStatuses[stepId] = 'done';
      } else if (state.stepStatuses[stepId] === 'done') {
        state.stepStatuses[stepId] = 'pending';
      }
    }
    state.goal = record.summary.goal;
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
    applyToolPart(state, part as ToolPartLike);
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

function applyToolPart(state: ExecutionState, part: ToolPartLike): void {
  const toolName = part.toolName ?? part.type.slice('tool-'.length);
  const stepId = readStepId(part.output) ?? undefined;

  if (part.state === 'output-available') {
    state.toolCalls += 1;
    state.observations.push({
      id: part.toolCallId,
      cycle: state.cycle,
      kind: 'tool-result',
      tool: toolName,
      stepId,
      summary: `${toolName} returned a result.`,
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
      summary: part.errorText ?? `${toolName} failed.`,
      detail: part.input,
    };
    state.observations.push(observation);
  }
}

function readStepId(output: unknown): string | undefined {
  if (typeof output === 'object' && output !== null && 'stepId' in output) {
    const value = (output as { stepId: unknown }).stepId;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export function statusesFor(plan: Plan | undefined, statuses: Record<string, StepStatus>): Record<string, StepStatus> {
  if (plan === undefined) return {};
  const result: Record<string, StepStatus> = {};
  for (const step of plan.steps) {
    result[step.id] = statuses[step.id] ?? 'pending';
  }
  return result;
}
