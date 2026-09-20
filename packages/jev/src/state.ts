import { presentResult, type ControllerContext } from '@keeled/core';
import type { JsonValue } from '@typesafe-ai/sdk';
import { callHistory } from './history.ts';
import { sdkValue } from './sdk.ts';

/** Per-result size for the state document; larger results are paged, never cut. */
const resultBudget = 4_000;

/** The state document Jev evaluates. It is data, never instructions. */
export function controllerState(context: ControllerContext): { [key: string]: JsonValue } {
  return sdkValue<{ [key: string]: JsonValue }>({
    latest_user_message: context.request,
    task: context.state.task,
    discovery_judgments: context.state.discovery,
    application_inspections: context.state.inspections,
    tool_catalog: context.toolCatalog ?? context.availableTools,
    uncertain_operations: context.state.uncertainOperations,
    agent_instructions: context.instructions,
    // Tool calls in the order they were made, each with its reference, input, and result.
    // A large result appears as a page of complete records with its omissions stated.
    tool_calls: callHistory(context)
      .slice(-30)
      .map((call) => ({
        ref: call.ref,
        turn: call.turn,
        tool: call.tool,
        input: jsonValue(call.input),
        outcome: call.outcome,
        result: jsonValue(presentResult(call.result, call.ref, resultBudget)),
      })),
    // Everything else the turn has observed: blocked attempts and input errors.
    evidence: context.observations
      .filter((observation) => observation.kind !== 'tool-result' && observation.kind !== 'tool-error')
      .slice(-12)
      .map((observation) => ({
        kind: observation.kind,
        tool: observation.tool ?? null,
        summary: observation.summary,
        detail: jsonValue(presentResult(observation.detail, observation.id, resultBudget)),
      })),
    awaiting_confirmation: context.awaitingConfirmation.map((held) => ({
      tool: held.tool,
      input: jsonValue(held.input),
      reason: held.reason,
    })),
    blockers: context.blockers.slice(-6).map((blocker) => ({
      kind: blocker.kind,
      tool: blocker.tool ?? null,
      reason: blocker.reason,
      resolution: blocker.resolution,
    })),
    budget: context.budget,
    transcript: context.conversation.flatMap((message) =>
      message.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => ({ role: message.role, text: part.text })),
    ),
  });
}

function jsonValue(value: import('@keeled/core').JsonValue): JsonValue {
  // SAFETY: the adjacent validation or framework contract establishes the asserted type.
  return value === undefined ? null : (value as JsonValue);
}
