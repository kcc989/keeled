import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk';
import type { JsonValue, NoulResponse, Questions, Usage } from '@typesafe-ai/sdk';
import {
  parseRespondLabel,
  stableHash,
  respondLabels,
  type Controller,
  type ControllerContext,
  type ControlResult,
  type Authorization,
  type NextAction,
  type PendingAction,
  type UsageBucket,
} from '@keeled/core';
import { blockerNote, callHistory, repetitionNote, respondNotes } from './history.ts';
import { controllerState } from './state.ts';
import { sdkValue } from './sdk.ts';
import {
  buildGuide,
  guideIdentity,
  guideNote,
  guideOptions,
  type GuideAnswers,
  type GuideAsk,
  type ResolvedGuideOptions,
  type ToolGuide,
  type ToolGuideOptions,
} from './guide.ts';

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
  /**
   * Opt-in tool guide. Once per set of instructions and tool catalog, Jev indexes which
   * instruction segments govern each tool and which tool supplies each required input; tool
   * options then quote those segments and say whether each input's source has returned a
   * result. Off by default.
   */
  toolGuide?: boolean | ToolGuideOptions;
  /** Reports each guide build, so a host can record what the guide contained. */
  onToolGuide?: (event: ToolGuideEvent) => void;
  /** Time limit for one guide build. A build that exceeds it fails, and selection runs without a guide. Default 120 seconds. */
  toolGuideTimeoutMs?: number;
}

export type ToolGuideEvent =
  | { type: 'built'; guide: ToolGuide; ms: number }
  | { type: 'failed'; key: string; error: string; ms: number };

interface GuideEntry {
  promise: Promise<ToolGuide | undefined>;
  /** The build's usage is charged to one decision only. */
  charged: boolean;
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

  const guideSettings: ResolvedGuideOptions | undefined =
    options.toolGuide === undefined || options.toolGuide === false
      ? undefined
      : guideOptions(options.toolGuide === true ? {} : options.toolGuide);

  // One build per identity, shared by every conversation this controller serves.
  const guides = new Map<string, GuideEntry>();

  const guideFor = async (
    context: ControllerContext,
    settings: ResolvedGuideOptions,
  ): Promise<{ guide: ToolGuide | undefined; usage?: UsageBucket }> => {
    const catalog = context.toolCatalog ?? context.availableTools;
    const identity = guideIdentity(context.instructions, catalog, model, settings);
    let entry = guides.get(identity);

    if (entry === undefined) {
      const key = stableHash(identity);
      const started = performance.now();
      // The build outlives any one turn, so a cancelled turn does not cancel it for others.
      const signal = AbortSignal.timeout(options.toolGuideTimeoutMs ?? 120_000);

      const ask: GuideAsk = async (state, questions) => {
        const result = await client.systemOne({ state, questions, model }, { signal });

        // SAFETY: the SDK returns one Choice or Noul answer for each question it was sent.
        return { answers: sdkValue<GuideAnswers>(result.answers), usage: result.usage };
      };

      const promise = buildGuide(ask, key, context.instructions, catalog, settings).then(
        (guide) => {
          options.onToolGuide?.({ type: 'built', guide, ms: Math.round(performance.now() - started) });

          return guide;
        },
        (error) => {
          options.onToolGuide?.({
            type: 'failed',
            key,
            error: error instanceof Error ? error.message : String(error),
            ms: Math.round(performance.now() - started),
          });

          return undefined;
        },
      );

      entry = { promise, charged: false };
      guides.set(identity, entry);
    }

    const guide = await untilAborted(context.abortSignal, entry.promise);

    if (guide === undefined || entry.charged) return { guide };
    entry.charged = true;

    return { guide, usage: guide.usage };
  };

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
      const indexed = guideSettings === undefined ? undefined : await guideFor(context, guideSettings);
      const guide = indexed?.guide;

      for (const tool of context.availableTools) {
        const guidance =
          tool.risk === 'read'
            ? ' Select this when it can retrieve information needed for the request, including by inspecting known identifiers from earlier results.'
            : ' Select this when the requested state change and its exact arguments are supported by the conversation and tool results; the runtime will enforce policy and confirmation.';

        criteria[tool.name] =
          `${tool.description} (risk: ${tool.risk})` +
          guidance +
          (guide === undefined || guideSettings === undefined
            ? ''
            : guideNote(tool.name, guide, history, guideSettings)) +
          `${repetitionNote(tool.name, history)}${blockerNote(tool.name, context.blockers)}`;

        if (tool.resolutionBlocked !== undefined) delete criteria[tool.name];
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

      const action: NextAction = outcome === undefined ? { type: 'tool', tool: label } : { type: 'respond', outcome };

      return {
        action,
        rationale: `Jev selected "${label}".`,
        confidence: answers.action.confidence,
        probabilities: answers.action.probabilities,
        usage: addUsage(toBucket(result.usage), indexed?.usage),
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

function addUsage(usage: UsageBucket, extra: UsageBucket | undefined): UsageBucket {
  if (extra === undefined) return usage;

  return {
    calls: usage.calls + extra.calls,
    inputTokens: usage.inputTokens + extra.inputTokens,
    outputTokens: usage.outputTokens + extra.outputTokens,
  };
}

/** Waits for a shared operation, but stops waiting when this caller's turn is cancelled. */
async function untilAborted<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};

  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function toBucket(usage: Usage): UsageBucket {
  return { calls: 1, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}
