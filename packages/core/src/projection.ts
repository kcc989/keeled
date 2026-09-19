import type { ModelMessage } from 'ai';
import type { AgentMessage, ExecutionState, Observation } from './types.ts';
import type { Plan, StepStatus } from './plan.ts';

/**
 * Explicit projection of conversation history for model calls.
 *
 * Only text carries into model messages. Tool evidence and operational transitions
 * reach the model through a compact digest, so that a partially assembled tool part
 * can never produce an unpaired tool call in the prompt.
 */
export function projectMessages(conversation: readonly AgentMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const message of conversation) {
    if (message.role === 'system') continue;
    const text = message.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map(part => part.text)
      .join('')
      .trim();
    if (text.length === 0) continue;
    messages.push({ role: message.role === 'user' ? 'user' : 'assistant', content: text });
  }

  return messages;
}

export function latestRequest(conversation: readonly AgentMessage[]): string {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (message?.role !== 'user') continue;
    const text = message.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map(part => part.text)
      .join('')
      .trim();
    if (text.length > 0) return text;
  }
  return '';
}

export function digestObservations(observations: readonly Observation[], limit = 12): string {
  if (observations.length === 0) return 'No tool evidence yet.';
  return observations
    .slice(-limit)
    .map(observation => {
      const scope = observation.tool === undefined ? '' : ` [${observation.tool}]`;
      const detail = observation.detail === undefined ? '' : ` ${truncate(json(observation.detail), 400)}`;
      return `- (${observation.kind})${scope} ${observation.summary}${detail}`;
    })
    .join('\n');
}

export function digestPlan(
  plan: Plan | undefined,
  statuses: Readonly<Record<string, StepStatus>>,
): string {
  if (plan === undefined) return 'No plan.';
  const steps = plan.steps
    .map(step => {
      const dependencies = step.dependencies.length === 0 ? 'none' : step.dependencies.join(', ');
      return `- ${step.id} [${statuses[step.id] ?? 'pending'}] ${step.objective} (depends on: ${dependencies})`;
    })
    .join('\n');
  return `Objective: ${plan.objective}\nRevision: ${plan.version}\n${steps}`;
}

export function digestState(state: Readonly<ExecutionState>): Record<string, unknown> {
  return {
    cycle: state.cycle,
    stepsUsed: state.stepsUsed,
    toolCalls: state.toolCalls,
    planRevisions: state.planRevisions,
    stepStatuses: state.stepStatuses,
    blockers: state.blockers.slice(-4).map(blocker => blocker.reason),
  };
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
