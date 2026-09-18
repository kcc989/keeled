import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk';
import type { JsonValue, NoulResponse, Questions, Usage } from '@typesafe-ai/sdk';
import {
  parseRespondLabel,
  respondLabels,
  type Controller,
  type ControllerContext,
  type ControllerDecision,
  type Authorization,
  type NextAction,
  type PendingAction,
  type ReplyReview,
  type ProgressAssessment,
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
 * Jev selects the next action and assesses progress. It never generates text, and its
 * selection confidence never authorises execution on its own.
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

    async decide(context: ControllerContext): Promise<ControllerDecision> {
      const history = callHistory(context);
      const criteria: Record<string, string> = {};
      for (const tool of context.availableTools) {
        const guidance = tool.isPlanningTool
          ? ' Use this before work that has multiple obligations, multiple entities, or several dependent actions.'
          : tool.risk === 'read'
            ? ' Select this when it can retrieve information needed for the request, including by inspecting known identifiers from earlier results.'
            : ' Select this when the requested state change and its exact arguments are supported by the conversation and tool results; the runtime will enforce policy and confirmation.';
        criteria[tool.name] =
          `${tool.description} (risk: ${tool.risk})` +
          guidance +
          `${repetitionNote(tool.name, history)}${blockerNote(tool.name, context.blockers)}` +
          readinessNote(tool, context, history);
      }
      const notes = respondNotes(context.blockers);
      criteria[respondLabels.completed] =
        'Stop and answer the user. Select only when the evidence shows the request is satisfied.' + notes.completed;
      criteria[respondLabels.needs_input] =
        'Stop and ask the user. Select only when required information is owned by the user and no available ' +
        'tool can retrieve it, or when an action needs the user\'s confirmation. Known identifiers and records ' +
        'returned by tools must be inspected before asking the user.' +
        notes.needsInput;
      criteria[respondLabels.blocked] =
        'Stop and explain. Select only when the work cannot continue with any available tool or permitted alternative.';

      const readySteps = context.readySteps;
      const stepCriteria: Record<string, string> = {};
      for (const step of readySteps) stepCriteria[step.id] = step.objective;

      const questions: Questions = {
        action: choice('Which action should the agent take next?', criteria),
      };
      if (readySteps.length > 1) {
        questions['step'] = choice('Which plan step should the next action serve?', stepCriteria);
      }

      const result = await request(context, questions);
      const answers = result.answers as unknown as {
        action: ChoiceAnswer;
        step?: ChoiceAnswer;
      };

      const label = answers.action.choice;
      const outcome = parseRespondLabel(label);
      const stepId =
        readySteps.length === 1 ? readySteps[0]?.id : answers.step?.choice;

      // Jev selects; it does not write. The objective comes from the plan step the action
      // serves, and the evidence names this turn's earlier calls of the same tool, so input
      // resolution can see what has already been asked.
      const objective = readySteps.find(step => step.id === stepId)?.objective;
      const evidence = history.filter(call => call.turn === 'current' && call.tool === label).map(call => call.ref);
      const action: NextAction =
        outcome === undefined
          ? {
              type: 'tool',
              tool: label,
              ...(stepId === undefined ? {} : { stepId }),
              ...(objective === undefined ? {} : { objective }),
              ...(evidence.length === 0 ? {} : { evidence }),
            }
          : { type: 'respond', outcome };

      return {
        action,
        rationale: `Jev selected "${label}".`,
        confidence: answers.action.confidence,
        probabilities: answers.action.probabilities,
        usage: toBucket(result.usage),
      };
    },

    async assess(context: ControllerContext): Promise<ProgressAssessment> {
      const steps = context.plan?.steps ?? [];
      const keys = steps.map((step, index) => [`step_${index}`, step.id] as const);

      const stepQuestions: Record<string, ReturnType<typeof noul>> = {};
      for (const [key, stepId] of keys) {
        const step = steps.find(candidate => candidate.id === stepId);
        stepQuestions[key] = noul(`Is this plan step complete: ${step?.objective ?? stepId}?`, {
          true: 'The evidence shows this step’s objective is achieved.',
          false: 'The evidence does not yet show this step’s objective is achieved.',
        });
      }

      const questions = {
        ...stepQuestions,
        goal: noul('Has the original request been fully satisfied by the evidence so far?', {
          true: 'Every part of the request is addressed by the evidence.',
          false: 'Some part of the request is not yet addressed by the evidence.',
        }),
        planValid: noul('Is the current plan still a valid route to the original request?', {
          true: 'The plan still describes work that leads to the request.',
          false: 'Observations have invalidated the plan.',
        }),
      } satisfies Questions;

      const result = await request(context, questions);
      const answers = result.answers as unknown as Record<string, NoulResponse>;

      const stepResults: ProgressAssessment['steps'] = {};
      for (const [key, stepId] of keys) {
        const answer = answers[key];
        stepResults[stepId] = grade(answer, threshold);
      }

      const goal = grade(answers['goal'], threshold);
      const planValid = grade(answers['planValid'], threshold);

      return {
        steps: stepResults,
        goalMet: goal,
        planValid: { valid: planValid.complete, confidence: planValid.confidence },
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
