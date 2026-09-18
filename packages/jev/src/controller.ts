import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk';
import type { NoulResponse, Questions, Usage } from '@typesafe-ai/sdk';
import {
  parseRespondLabel,
  respondLabels,
  type Controller,
  type ControllerContext,
  type ControllerDecision,
  type NextAction,
  type ProgressAssessment,
  type UsageBucket,
} from '@keeled/core';
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

  const request = <Q extends Questions>(context: ControllerContext, questions: Q) =>
    client.systemOne(
      { state: controllerState(context), questions, ...(model === undefined ? {} : { model }) },
      { signal: context.abortSignal },
    );

  return {
    name: 'jev',

    async decide(context: ControllerContext): Promise<ControllerDecision> {
      const criteria: Record<string, string> = {};
      for (const tool of context.availableTools) {
        criteria[tool.name] = `${tool.description} (risk: ${tool.risk})`;
      }
      criteria[respondLabels.completed] =
        'Stop and answer the user. Select only when the evidence shows the request is satisfied.';
      criteria[respondLabels.needs_input] =
        'Stop and ask the user. Select when required information is missing and no tool can obtain it.';
      criteria[respondLabels.blocked] =
        'Stop and explain. Select when the work cannot continue with the tools available.';

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

      const action: NextAction =
        outcome === undefined
          ? { type: 'tool', tool: label, ...(stepId === undefined ? {} : { stepId }) }
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
  };
}

/**
 * Turns a probability into a decision plus the distance from the threshold, which the
 * runtime uses as confidence. A probability sitting on the threshold carries no confidence.
 */
function grade(answer: NoulResponse | undefined, threshold: number): {
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
