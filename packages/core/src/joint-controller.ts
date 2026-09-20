import { z } from 'zod';
import { HarnessError } from './errors.ts';
import { isJsonValue } from './json.ts';
import { callHistory, digestObservations, presentResult, projectMessages } from './projection.ts';
import type { Controller, ControllerContext, NextAction } from './controller.ts';
import type { GeneratedToolCall } from './types.ts';
import type { LanguageModel } from 'ai';

const responseTools = {
  __keeled_respond_completed: 'completed',
  __keeled_respond_needs_input: 'needs_input',
  __keeled_respond_blocked: 'blocked',
} as const;

const responseOutcomes = new Map<string, (typeof responseTools)[keyof typeof responseTools]>(
  Object.entries(responseTools),
);

const emptyInput = z.strictObject({});

export interface JointControllerOptions {
  /** Model used for the complete tool-or-response decision. Defaults to the agent model. */
  model?: LanguageModel;
  /** Usually the existing Jev authorizer, so write policy stays fixed. */
  authorize?: Controller['authorize'];
}

/**
 * Selects a tool and its complete input in one managed model request. The runtime remains
 * the only executor and applies the same availability, validation, policy, and authorization checks.
 */
export function jointController(options: JointControllerOptions = {}): Controller {
  return {
    name: 'joint',
    inputMode: 'joint',
    authorize: options.authorize,

    async control(context: ControllerContext) {
      const tools = context.availableTools
        .filter((entry) => entry.resolutionBlocked === undefined)
        .map((entry) => ({ name: entry.name, description: entry.description, inputSchema: entry.inputSchema }));

      tools.push(
        {
          name: '__keeled_respond_completed',
          description:
            'Stop and answer the user because all requested outcomes are supported by the conversation and tool results, or no tool is needed.',
          inputSchema: emptyInput,
        },
        {
          name: '__keeled_respond_needs_input',
          description:
            'Stop and ask the user only when required information belongs to the user, no available tool can retrieve it, or exact confirmation is required.',
          inputSchema: emptyInput,
        },
        {
          name: '__keeled_respond_blocked',
          description: 'Stop and explain because no available tool or permitted alternative can continue the work.',
          inputSchema: emptyInput,
        },
      );

      const history = callHistory(context.conversation, context.observations).map((call) => ({
        ...call,
        result: presentResult(call.result, call.ref),
      }));

      const result = await context.generateToolCalls({
        purpose: 'joint_decision',
        model: options.model,
        tools,
        system:
          'Choose exactly one next action. Call one supplied function. For an application tool, provide its complete input using only values supported by the request, conversation, and tool evidence. Never invent identifiers, constraints, or placeholders. Use a response function only when its description is true. The runtime alone executes application tools and enforces validation, policy, authorization, and confirmation.',
        prompt: [
          `Agent instructions:\n${context.instructions}`,
          `Current request:\n${context.request}`,
          `Conversation:\n${JSON.stringify(projectMessages(context.conversation))}`,
          `Tool calls and results:\n${JSON.stringify(history)}`,
          `Recent evidence:\n${digestObservations(context.observations)}`,
          `Retained goals and constraints:\n${JSON.stringify(context.state.task)}`,
          `Application inspections:\n${JSON.stringify(context.state.inspections)}`,
          `Current blockers:\n${JSON.stringify(context.blockers.slice(-8))}`,
          `Held confirmations:\n${JSON.stringify(context.awaitingConfirmation)}`,
          `Work budget:\n${JSON.stringify(context.budget)}`,
        ].join('\n\n'),
        abortSignal: context.abortSignal,
      });

      if (result.calls.length !== 1) {
        throw new HarnessError(
          `[joint_decision_call_count] Expected exactly one tool call, received ${result.calls.length}.`,
        );
      }

      const call = result.calls[0]!;

      if (call.invalid === true) {
        throw new HarnessError(`[joint_decision_invalid] ${call.error ?? `Invalid call to "${call.tool}".`}`);
      }

      const outcome = responseOutcomes.get(call.tool);

      const action: NextAction = outcome === undefined ? completeCall(call) : { type: 'respond', outcome };

      return {
        action,
        rationale: `The joint model proposed "${call.tool}" with its complete input.`,
      };
    },
  };
}

function completeCall(call: GeneratedToolCall): Extract<NextAction, { type: 'tool_call' }> {
  if (!isJsonValue(call.input)) {
    throw new HarnessError(`[joint_decision_non_json] The proposed input for "${call.tool}" is not JSON-serializable.`);
  }

  return { type: 'tool_call', tool: call.tool, input: call.input };
}
