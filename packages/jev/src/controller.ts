import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk';
import type { JsonValue, NoulResponse, Questions, Usage } from '@typesafe-ai/sdk';
import {
  parseRespondLabel,
  respondLabels,
  type Controller,
  type ControllerContext,
  type ControlResult,
  type Authorization,
  type NextAction,
  type PendingAction,
  type UsageBucket,
} from '@keeled/core';
import { blockerNote, callHistory, readinessNote, repetitionNote, respondNotes } from './history.ts';
import { controllerState } from './state.ts';
import { sdkValue } from './sdk.ts';

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

export interface Grade {
  complete: boolean;
  confidence: number;
}

/**
 * Jev selects a tool or a reply. Code validates input and controls execution.
 */
export function jev(options: JevControllerOptions = {}): Controller {
  const client = options.client ?? new TypeSafeClient();
  const threshold = options.noulThreshold ?? 0.5;
  const model = options.model;

  const request = <Q extends Questions>(
    context: ControllerContext,
    questions: Q,
    extra: { [key: string]: JsonValue } = {},
  ) => {
    const input = { state: { ...controllerState(context), ...extra }, questions, model };

    return client.systemOne(input, { signal: context.abortSignal });
  };

  return {
    name: 'jev',

    async control(context: ControllerContext): Promise<ControlResult> {
      const history = callHistory(context);
      const criteria: Record<string, string> = {};
      const readyCalls = new Map<string, { tool: string; candidateId: string }>();

      for (const tool of context.availableTools) {
        const guidance =
          tool.risk === 'read'
            ? ' Select this when it can retrieve information needed for the request, including by inspecting known identifiers from earlier results.'
            : ' Select this when the requested state change and its exact arguments are supported by the conversation and tool results; the runtime will enforce policy and confirmation.';

        criteria[tool.name] =
          `${tool.description} (risk: ${tool.risk})` +
          guidance +
          `${repetitionNote(tool.name, history)}${blockerNote(tool.name, context.blockers)}` +
          readinessNote(tool, context, history);

        if (tool.resolutionBlocked !== undefined) delete criteria[tool.name];

        if (tool.risk === 'read' && tool.candidates?.length) {
          if (criteria[tool.name] !== undefined)
            criteria[tool.name] +=
              ' Use this fallback only when none of the ready calls for this tool fits; its arguments will need resolution.';

          for (const candidate of tool.candidates) {
            readyCalls.set(candidate.id, { tool: tool.name, candidateId: candidate.id });
            criteria[candidate.id] =
              `Execute ${tool.name} with exact input ${JSON.stringify(candidate.input)}. ` +
              `${tool.description} ${candidate.description} Evidence: ${candidate.sources.join(', ')}. ` +
              'Select only when this specific call advances the user request and its result is still needed.';
          }
        }
      }

      const notes = respondNotes(context.blockers);
      criteria[respondLabels.needs_input] =
        'Stop and ask the user. Select only when required information is owned by the user and no available ' +
        "tool can retrieve it, or when an action needs the user's confirmation. Known identifiers and records " +
        'returned by tools must be inspected before asking the user.' +
        notes.needsInput;
      criteria[respondLabels.blocked] =
        'Stop and explain. Select only when the work cannot continue with any available tool or permitted alternative.';

      criteria[respondLabels.completed] =
        'Stop and answer the user. Select when the conversation and tool results support all requested outcomes, or the request can be answered directly without a tool.';

      const questions: Questions = {
        action: choice('Which action should the agent take next?', criteria),
      };

      const result = await request(context, questions);

      // SAFETY: the adjacent validation or framework contract establishes the asserted type.
      const answers = sdkValue<{
        action: ChoiceAnswer;
      }>(result.answers);

      const label = answers.action.choice;
      const outcome = parseRespondLabel(label);

      const action: NextAction =
        outcome === undefined
          ? {
              type: 'tool',
              ...(readyCalls.get(label) ?? { tool: label }),
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

    async authorize(context: ControllerContext, action: PendingAction): Promise<Authorization> {
      const questions = {
        permitted: noul(
          'Do the agent instructions permit these exact effects now, given the verified application facts and tool results? Apply only rules for this operation, not different operations supported by the same tool. Respect all retained user constraints.',
          {
            true: 'The instructions set no conditions on this kind of action, or every condition they set is shown to be met by the tool results.',
            false:
              'A condition the instructions set on this kind of action is unmet, or the tool results do not yet show that it is met.',
          },
        ),
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
          // SAFETY: the adjacent validation or framework contract establishes the asserted type.
          input: action.input as JsonValue,
          // SAFETY: the adjacent validation or framework contract establishes the asserted type.
          verified_facts: (action.facts ?? {}) as JsonValue,
          effects: action.effects ?? [],
        },
      });

      // SAFETY: the adjacent validation or framework contract establishes the asserted type.
      const answers = result.answers as Record<string, NoulResponse>;

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
  };
}

/**
 * Turns a probability into a decision plus the distance from the threshold, which the
 * runtime uses as confidence. A probability sitting on the threshold carries no confidence.
 */
export function grade(answer: NoulResponse | undefined, threshold: number): Grade {
  if (answer === undefined) return { complete: false, confidence: 0 };
  const complete = answer.noul >= threshold;
  const span = complete ? 1 - threshold : threshold;
  const confidence = span === 0 ? 1 : Math.abs(answer.noul - threshold) / span;

  return { complete, confidence };
}

function toBucket(usage: Usage): UsageBucket {
  return { calls: 1, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}
