import { z } from 'zod';
import { agentTool, type AgentContext, type AgentTool } from './tool.ts';
import { taskStateProposalSchema, type TaskStateProposal } from './plan.ts';
import { callHistory, digestObservations, digestPlan, presentResult } from './projection.ts';
import type { LanguageModel } from 'ai';

const planningInputSchema = z.object({
  reason: z.string().min(1).describe('Why a plan is being created or revised.'),
});

export interface PlanningToolOptions {
  description?: string;
  model?: LanguageModel;
  instructions?: string;
}

const defaultInstructions = [
  'You update durable task state for an agent runtime.',
  'Return the overall objective, user constraints, known facts, and a short ordered list of outcome goals.',
  'Goals say what must become true. They never name tools or prescribe calls.',
  'Order goals by when their outcomes are needed. Completion criteria state what evidence proves each goal is achieved.',
  'Treat user statements and tool results as facts only when the conversation supports them. Do not infer missing values.',
  'The task state survives while work waits for user input. New user information may add constraints, facts, or goals.',
  'Preserve achieved and unchanged goals and their ids. Change only what the update reason requires.',
].join(' ');

/**
 * The default planning tool. It is an ordinary agent tool: the controller selects it,
 * and the runtime validates its proposal and assigns the next revision.
 */
export function taskStateTool(options: PlanningToolOptions = {}): AgentTool<
  { reason: string },
  TaskStateProposal
> {
  return agentTool({
    description:
      options.description ??
      'Create or update ordered outcome goals, constraints, and known facts at task setup, after new user information, or when progress fails.',
    inputSchema: planningInputSchema,
    outputSchema: taskStateProposalSchema,
    risk: 'read',
    model: options.model,
    resolveInput: context => {
      if (context.action?.objective !== undefined) return { reason: context.action.objective };
      const blocker = context.state.blockers.at(-1);
      const failure = context.state.observations.filter(o => o.kind === 'tool-error').at(-1);
      if (blocker !== undefined) return { reason: `Blocked: ${blocker.reason}` };
      if (failure !== undefined) return { reason: `Failure: ${failure.summary}` };
      if (context.state.plan?.kind === 'explicit') return { reason: 'Update task state against current evidence.' };
      return { reason: 'The request needs explicit ordered goals and task state.' };
    },
    execute: async (input, context) => {
      const result = await context.generateObject<TaskStateProposal>({
        schema: taskStateProposalSchema,
        name: 'task_state',
        system: options.instructions ?? defaultInstructions,
        prompt: [
          `Latest request:\n${context.request}`,
          `Conversation:\n${transcript(context)}`,
          `Agent instructions:\n${context.instructions}`,
          `Current task state:\n${digestPlan(context.plan, context.state.stepStatuses)}`,
          `Tool calls so far:\n${calls(context)}`,
          `Other evidence this turn:\n${digestObservations(
            context.state.observations.filter(o => o.kind !== 'tool-result' && o.kind !== 'tool-error'),
          )}`,
          `Reason for updating task state:\n${input.reason}`,
          'Return the replacement task state. Preserve achieved goals and append new goals only when the request requires another outcome.',
        ].join('\n\n'),
        abortSignal: context.abortSignal,
      });
      return result.object;
    },
  });
}

/** @deprecated Use taskStateTool. */
export const planningTool = taskStateTool;

// A plan serves the whole conversation: the request may have been made turns before the
// latest message, and the evidence gathered for it may come from earlier turns.
function transcript(context: AgentContext): string {
  return context.messages
    .map(message => `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`)
    .join('\n');
}

function calls(context: AgentContext): string {
  const history = callHistory(context.conversation, context.state.observations);
  if (history.length === 0) return 'None.';
  return history
    .map(
      call =>
        `- [${call.ref}] ${call.tool}(${JSON.stringify(call.input)}) ` +
        (call.outcome === 'result' ? `returned ${JSON.stringify(presentResult(call.result, call.ref))}` : `failed: ${String(call.result)}`),
    )
    .join('\n');
}
