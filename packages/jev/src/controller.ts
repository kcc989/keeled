import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk';
import type { JsonValue, NoulResponse, Questions, Usage } from '@typesafe-ai/sdk';
import {
  parseRespondLabel,
  respondLabels,
  stepCompleteLabel,
  type Controller,
  type ControllerContext,
  type ControlResult,
  type Authorization,
  type NextAction,
  type PendingAction,
  type ReplyReview,
  type UsageBucket,
} from '@keeled/core';
import { blockerNote, callHistory, readinessNote, repetitionNote, respondNotes } from './history.ts';
import { controllerState } from './state.ts';

interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevControllerOptions {
  client?: TypeSafeClient;
  /** Jev model name. Defaults to the client's configured model. */
  model?: string;
  /** Probability above which a noul answer counts as true. */
  noulThreshold?: number;
}

/**
 * Jev selects one bounded action for the current ordered goal. Code owns task state,
 * progress, and which actions are currently valid.
 */
export function jev(options: JevControllerOptions = {}): Controller {
  const client = options.client ?? new TypeSafeClient();
  const threshold = options.noulThreshold ?? 0.5;
  const model = options.model;

  const request = <Q extends Questions>(
    context: ControllerContext,
    questions: Q,
    extra: { [key: string]: JsonValue } = {},
  ) =>
    client.systemOne(
      { state: { ...controllerState(context), ...extra }, questions, ...(model === undefined ? {} : { model }) },
      { signal: context.abortSignal },
    );

  return {
    name: 'jev',

    async control(context: ControllerContext): Promise<ControlResult> {
      const history = callHistory(context);
      const criteria: Record<string, string> = {};
      let taskStateTool: string | undefined;
      for (const tool of context.availableTools) {
        if (tool.isPlanningTool) {
          taskStateTool = tool.name;
          continue;
        }
        const guidance =
          tool.risk === 'read'
            ? ' Select this when it can retrieve information needed for the request, including by inspecting known identifiers from earlier results.'
            : ' Select this when the requested state change and its exact arguments are supported by the conversation and tool results; the runtime will enforce policy and confirmation.';
        criteria[tool.name] =
          `${tool.description} (risk: ${tool.risk})` +
          guidance +
          `${repetitionNote(tool.name, history)}${blockerNote(tool.name, context.blockers)}` +
          readinessNote(tool, context, history);
      }
      const notes = respondNotes(context.blockers);
      const goal = context.currentGoal;
      criteria[respondLabels.needs_input] =
        'Stop and ask the user. Select only when required information is owned by the user and no available ' +
        'tool can retrieve it, or when an action needs the user\'s confirmation. Known identifiers and records ' +
        'returned by tools must be inspected before asking the user.' +
        notes.needsInput;
      criteria[respondLabels.blocked] =
        'Stop and explain. Select only when the work cannot continue with any available tool or permitted alternative.';

      const questions: Questions = {
        action: choice('Which action should the agent take next?', criteria),
      };
      if (goal !== undefined) {
        questions['goal_achieved'] = noul(
          `Is the current goal achieved according to its completion criterion: ${goal.completionCriteria}?`,
          {
            true:
              'The conversation and cited tool evidence establish the required outcome, or the outcome can now be given directly in the final response.',
            false: 'The required outcome is not yet established and another action or user answer is needed.',
          },
        );
      }
      if (taskStateTool !== undefined) {
        const updating = context.taskState?.kind === 'explicit';
        questions['update_task_state'] = noul(
          updating
            ? 'Does the latest user message add or change a goal or constraint in the active task state?'
            : 'Does the current request contain multiple outcome goals or constraints that should be recorded before taking a domain action?',
          {
            true:
              updating
                ? 'It requests an additional outcome, changes a required outcome, or states a constraint that affects how the active task may be completed.'
                : 'The request has multiple distinct outcomes or constraints whose progress must be retained and checked separately.',
            false:
              updating
                ? 'It only supplies a fact, identifier, answer, or confirmation needed by an existing goal, without adding or changing an outcome or constraint.'
                : 'The request has one outcome and can proceed directly; missing information alone does not create another goal.',
          },
        );
      }
      const result = await request(context, questions);
      const answers = result.answers as unknown as {
        action: ChoiceAnswer;
        goal_achieved?: NoulResponse;
        update_task_state?: NoulResponse;
      };

      const stateUpdate = grade(answers.update_task_state, threshold);
      if (taskStateTool !== undefined && stateUpdate.complete) {
        return {
          action: { type: 'tool', tool: taskStateTool },
          rationale: 'Jev judged that the durable task state needs ordered goals or constraints updated.',
          confidence: stateUpdate.confidence,
          usage: toBucket(result.usage),
        };
      }

      const achieved = grade(answers.goal_achieved, threshold);
      if (goal !== undefined && achieved.complete) {
        return {
          action: { type: 'complete_step', stepId: goal.id },
          rationale: `Jev judged that goal "${goal.id}" is achieved.`,
          confidence: achieved.confidence,
          usage: toBucket(result.usage),
        };
      }

      const label = answers.action.choice;
      const outcome = parseRespondLabel(label);
      const evidence = history.filter(call => call.turn === 'current' && call.tool === label).map(call => call.ref);
      const action: NextAction =
        label === stepCompleteLabel
          ? { type: 'complete_step', ...(goal === undefined ? {} : { stepId: goal.id }) }
          : outcome === undefined
          ? {
              type: 'tool',
              tool: label,
              ...(goal === undefined ? {} : { stepId: goal.id, objective: goal.objective }),
              ...(evidence.length === 0 ? {} : { evidence }),
            }
          : { type: 'respond', outcome };

      return {
        action,
        rationale:
          goal === undefined ? `Jev selected "${label}".` : `Jev selected "${label}" for goal "${goal.id}".`,
        confidence: answers.action.confidence,
        probabilities: answers.action.probabilities,
        usage: toBucket(result.usage),
      };
    },

    async authorize(context: ControllerContext, action: PendingAction): Promise<Authorization> {
      const questions = {
        permitted: noul('Do the agent instructions permit the pending action now, given the tool results?', {
          true: 'The instructions set no conditions on this kind of action, or every condition they set is shown to be met by the tool results.',
          false: 'A condition the instructions set on this kind of action is unmet, or the tool results do not yet show that it is met.',
        }),
        needs_verification: noul(
          'Does deciding whether the pending action is permitted require arithmetic, or comparing dates, times, amounts, or counts?',
          {
            true: 'A condition depends on calculating or comparing dates, times, amounts, or counts.',
            false: 'Whether it is permitted can be read directly from the instructions and tool results.',
          },
        ),
        confirmed: noul(
          'If the agent instructions require the user to confirm this kind of action, has the user explicitly confirmed this exact action and its details?',
          {
            true: 'No confirmation is required, or the user explicitly agreed to this action after it was described to them.',
            false: 'Confirmation is required and the user has not explicitly agreed to this exact action.',
          },
        ),
      } satisfies Questions;

      const result = await request(context, questions, {
        pending_action: {
          tool: action.tool,
          description: action.description,
          risk: action.risk,
          input: action.input as JsonValue,
        },
      });
      const answers = result.answers as unknown as Record<string, NoulResponse>;
      const judge = (key: string) => {
        const graded = grade(answers[key], threshold);
        return { value: graded.complete, confidence: graded.confidence };
      };

      return {
        permitted: judge('permitted'),
        needsVerification: judge('needs_verification'),
        confirmed: judge('confirmed'),
        usage: toBucket(result.usage),
      };
    },

    async reviewReply(context: ControllerContext, reply: string): Promise<ReplyReview> {
      const questions = {
        addresses_request: noul(
          'Does the draft reply address everything the user asked in their latest message, either by answering it or by saying plainly why it cannot?',
          {
            true: 'Every part of the latest message is answered or explicitly declined with a reason.',
            false: 'Some part of the latest message is ignored or left unanswered.',
          },
        ),
        supported: noul(
          'Is every outcome the draft reply states, such as actions taken, amounts, or statuses, supported by the tool results?',
          {
            true: 'Each stated outcome matches the tool results.',
            false: 'The reply states an outcome, amount, or status that the tool results do not show.',
          },
        ),
      } satisfies Questions;

      const result = await request(context, questions, { draft_reply: reply });
      const answers = result.answers as unknown as Record<string, NoulResponse>;
      const judge = (key: string) => {
        const graded = grade(answers[key], threshold);
        return { value: graded.complete, confidence: graded.confidence };
      };
      return {
        addressesRequest: judge('addresses_request'),
        supported: judge('supported'),
        usage: toBucket(result.usage),
      };
    },
  };
}

/**
 * Turns a probability into a decision plus the distance from the threshold, which the
 * runtime uses as confidence. A probability sitting on the threshold carries no confidence.
 */
export function grade(answer: NoulResponse | undefined, threshold: number): {
  complete: boolean;
  confidence: number;
} {
  if (answer === undefined) return { complete: false, confidence: 0 };
  const complete = answer.noul >= threshold;
  const span = complete ? 1 - threshold : threshold;
  const confidence = span === 0 ? 1 : Math.abs(answer.noul - threshold) / span;
  return { complete, confidence };
}

function toBucket(usage: Usage): UsageBucket {
  return { calls: 1, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}
