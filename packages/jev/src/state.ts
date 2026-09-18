import { digestPlan, presentResult, type ControllerContext } from '@keeled/core';
import type { JsonValue } from '@typesafe-ai/sdk';
import { callHistory } from './history.ts';

/** Per-result size for the state document; larger results are paged, never cut. */
const resultBudget = 4_000;

/** The state document Jev evaluates. It is data, never instructions. */
export function controllerState(context: ControllerContext): { [key: string]: JsonValue } {
  return {
    original_request: context.request,
    agent_instructions: context.instructions,
    plan: context.plan === undefined ? null : digestPlan(context.plan, context.stepStatuses),
    ready_steps: context.readySteps.map(step => ({ id: step.id, objective: step.objective })),
    step_statuses: context.stepStatuses,
    // Tool calls in the order they were made, each with its reference, input, and result.
    // A large result appears as a page of complete records with its omissions stated.
    tool_calls: callHistory(context)
      .slice(-30)
      .map(call => ({
        ref: call.ref,
        turn: call.turn,
        tool: call.tool,
        input: jsonValue(call.input),
        outcome: call.outcome,
        result: jsonValue(presentResult(call.result, call.ref, resultBudget)),
      })),
    // Everything else the turn has observed: blocked attempts, plan revisions, input errors.
    evidence: context.observations
      .filter(observation => observation.kind !== 'tool-result' && observation.kind !== 'tool-error')
      .slice(-12)
      .map(observation => ({
        kind: observation.kind,
        tool: observation.tool ?? null,
        summary: observation.summary,
        detail: jsonValue(presentResult(observation.detail, observation.id, resultBudget)),
      })),
    awaiting_confirmation: context.awaitingConfirmation.map(held => ({
      tool: held.tool,
      input: jsonValue(held.input),
      reason: held.reason,
    })),
    blockers: context.blockers.slice(-6).map(blocker => ({
      kind: blocker.kind,
      tool: blocker.tool ?? null,
      reason: blocker.reason,
      resolution: blocker.resolution,
    })),
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

function jsonValue(value: unknown): JsonValue {
  return value === undefined ? null : (value as JsonValue);
}
