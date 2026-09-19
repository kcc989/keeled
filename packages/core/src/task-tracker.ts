import { jsonSchema } from 'ai';
import { callHistory } from './projection.ts';
import type { TaskPatch, GoalEvidence, TaskTracker } from './task.ts';

/** One additive update per user message, not a planner on every tool-selection cycle. */
export function modelTaskTracker(): TaskTracker {
  return {
    async update(context) {
      const result = await context.generateObject<TaskPatch>({
        name: 'task_update',
        schema: jsonSchema({ type: 'object', properties: {
          goals: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, text: { type: 'string' }, quote: { type: 'string' }, requiresWrite: { type: 'boolean' },
          }, required: ['id', 'text', 'quote', 'requiresWrite'] } },
          constraints: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, text: { type: 'string' }, quote: { type: 'string' },
          }, required: ['id', 'text', 'quote'] } },
          withdrawals: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, quote: { type: 'string' },
          }, required: ['id', 'quote'] } },
        }, required: ['goals', 'constraints', 'withdrawals'] }),
        system: 'Record only newly requested outcomes and constraints from the latest user message. ' +
          'Each quote must be an exact nonempty substring of that message. Preserve existing IDs and do not duplicate existing goals. ' +
          'A confirmation supplies details; it does not withdraw unfinished work or earlier constraints. ' +
          'Withdraw an item only if the user explicitly retracts or replaces it, citing their exact words. ' +
          'Keep separate requested effects as separate goals. Record limits on resource scope, quantities, timing, and allowed operations as constraints. ' +
          'Do not mark anything completed; execution evidence decides completion. Return empty lists if there is no update.',
        prompt: JSON.stringify({ existing: context.state.task, message: context.request, conversation: context.messages }),
      });
      return result.object;
    },
    async verify(context) {
      const result = await context.generateObject<{ checks: GoalEvidence[] }>({
        name: 'goal_evidence',
        schema: jsonSchema({ type: 'object', properties: { checks: { type: 'array', items: {
          type: 'object', properties: { id: { type: 'string' }, complete: { type: 'boolean' }, evidence: { type: 'array', items: { type: 'string' } } },
          required: ['id', 'complete', 'evidence'],
        } } }, required: ['checks'] }),
        system: 'Verify each pending outcome against actual successful tool results. Cite exact call references. ' +
          'A plan, confirmation, attempted tool, or success on another record does not complete an outcome. ' +
          'Check every requested record and all retained constraints. Completing a prerequisite does not complete a later dependent goal. ' +
          'For information requests, evidence must support the complete answer and any arithmetic. ' +
          'If evidence is missing or ambiguous, return complete=false.',
        prompt: JSON.stringify({ task: context.state.task, history: callHistory(context.conversation, context.state.observations) }),
      });
      return result.object.checks;
    },
  };
}
