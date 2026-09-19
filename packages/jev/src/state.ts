import { digestPlan, type ControllerContext } from '@keeled/core';
import type { JsonValue } from '@typesafe-ai/sdk';

/** The state document Jev evaluates. It is data, never instructions. */
export function controllerState(context: ControllerContext): { [key: string]: JsonValue } {
  return {
    original_request: context.request,
    agent_instructions: context.instructions,
    plan: context.plan === undefined ? null : digestPlan(context.plan, context.stepStatuses),
    ready_steps: context.readySteps.map(step => ({ id: step.id, objective: step.objective })),
    step_statuses: context.stepStatuses,
    evidence: context.observations.slice(-12).map(observation => ({
      kind: observation.kind,
      tool: observation.tool ?? null,
      summary: observation.summary,
      detail: truncate(observation.detail),
    })),
    blockers: context.blockers.slice(-6).map(blocker => blocker.reason),
    verification:
      context.verification === undefined
        ? null
        : {
            basis: context.verification.basis,
            goal: context.verification.goal.outcome,
            steps: Object.fromEntries(
              Object.entries(context.verification.steps).map(([id, step]) => [id, step.outcome]),
            ),
          },
    budget: context.budget,
    transcript: context.conversation
      .flatMap(message =>
        message.parts
          .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
          .map(part => ({ role: message.role, text: part.text })),
      )
      .slice(-10),
  } as unknown as { [key: string]: JsonValue };
}

function truncate(value: unknown, max = 600): JsonValue {
  if (value === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
  return json.length <= max ? (value as JsonValue) : `${json.slice(0, max)}…`;
}
