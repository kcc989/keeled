import { z } from 'zod';
import { agentTool, type AgentTool } from './tool.ts';
import { planProposalSchema, type PlanProposal } from './plan.ts';
import { digestObservations, digestPlan } from './projection.ts';
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
  'You produce a plan for an agent runtime.',
  'A plan states objectives and dependencies; it never names tools.',
  'Keep steps few, independent where possible, and ordered by dependency.',
  'Reuse a step id from the current plan when its objective is unchanged.',
].join(' ');

/**
 * The default planning tool. It is an ordinary agent tool: the controller selects it,
 * and the runtime validates its proposal and assigns the next revision.
 */
export function planningTool(options: PlanningToolOptions = {}): AgentTool<
  { reason: string },
  PlanProposal
> {
  return agentTool({
    description:
      options.description ??
      'Create or revise the plan. Select this when there is no plan, or when observations invalidate the current one.',
    inputSchema: planningInputSchema,
    outputSchema: planProposalSchema,
    risk: 'read',
    model: options.model,
    resolveInput: context => {
      const blocker = context.state.blockers.at(-1);
      const failure = context.state.observations.filter(o => o.kind === 'tool-error').at(-1);
      if (blocker !== undefined) return { reason: `Blocked: ${blocker.reason}` };
      if (failure !== undefined) return { reason: `Failure: ${failure.summary}` };
      if (context.state.plan !== undefined) return { reason: 'Revise the plan against current evidence.' };
      return { reason: 'No plan exists for this request.' };
    },
    execute: async (input, context) => {
      const result = await context.generateObject<PlanProposal>({
        schema: planProposalSchema,
        name: 'plan',
        system: options.instructions ?? defaultInstructions,
        prompt: [
          `Original request:\n${context.request}`,
          `Agent instructions:\n${context.instructions}`,
          `Current plan:\n${digestPlan(context.plan, context.state.stepStatuses)}`,
          `Evidence:\n${digestObservations(context.state.observations)}`,
          `Reason for planning:\n${input.reason}`,
          'Return the replacement plan.',
        ].join('\n\n'),
        abortSignal: context.abortSignal,
      });
      return result.object;
    },
  });
}
