import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type {
  Authorization,
  Controller,
  ControllerContext,
  ControlResult,
  ControllerDecision,
  NextAction,
  PendingAction,
} from './controller.ts';
import type { AgentMessage } from './types.ts';

export interface ScriptedAssessment {
  steps?: Record<string, { complete: boolean; confidence?: number }>;
  goalMet?: boolean;
  goalConfidence?: number;
}

export type ScriptedDecision =
  | NextAction
  | ControllerDecision
  | ((context: ControllerContext) => NextAction | ControllerDecision);

export interface ScriptedControllerOptions {
  decisions: ScriptedDecision[];
  assess?: ScriptedAssessment | ((context: ControllerContext) => ScriptedAssessment);
  /** Action used once the script runs out. Defaults to responding `blocked`. */
  fallback?: NextAction;
  /** When set, the controller authorizes pending calls with these answers. */
  authorize?: (
    action: PendingAction,
    context: ControllerContext,
  ) => { permitted: boolean; needsVerification?: boolean; confirmed: boolean };
}

/**
 * A deterministic controller for tests and offline demonstrations. It replaces the Jev
 * adapter without changing the execution path.
 */
export function scriptedController(options: ScriptedControllerOptions): Controller & {
  readonly consumed: number;
  readonly contexts: ControllerContext[];
} {
  let index = 0;
  const contexts: ControllerContext[] = [];

  return {
    name: 'scripted',
    get consumed() {
      return index;
    },
    get contexts() {
      return contexts;
    },
    async control(context: ControllerContext): Promise<ControlResult> {
      contexts.push(context);
      const source =
        typeof options.assess === 'function' ? options.assess(context) : (options.assess ?? {});
      const current = context.currentStep;
      const assessed = current === undefined ? undefined : source.steps?.[current.id];
      if (current !== undefined && assessed?.complete === true) {
        return {
          action: { type: 'complete_step', stepId: current.id },
          confidence: assessed.confidence ?? 1,
          usage: { calls: 1, inputTokens: 0, outputTokens: 0 },
        };
      }
      const entry = options.decisions[index];
      const resolved =
        entry === undefined
          ? options.fallback ?? { type: 'respond' as const, outcome: 'blocked' as const }
          : typeof entry === 'function'
            ? entry(context)
            : entry;
      const decision: ControllerDecision =
        'action' in resolved ? resolved : { action: resolved };
      index += 1;
      if (
        current !== undefined &&
        source.goalMet === true &&
        decision.action.type === 'respond' &&
        decision.action.outcome === 'completed'
      ) {
        return {
          action: { type: 'complete_step', stepId: current.id },
          confidence: source.goalConfidence ?? 1,
          usage: { calls: 1, inputTokens: 0, outputTokens: 0 },
        };
      }
      return {
        confidence: 1,
        ...decision,
        usage: { calls: 1, inputTokens: 0, outputTokens: 0 },
      };
    },
    ...(options.authorize === undefined
      ? {}
      : {
          async authorize(context: ControllerContext, action: PendingAction): Promise<Authorization> {
            const answer = options.authorize!(action, context);
            return {
              permitted: { value: answer.permitted, confidence: 1 },
              needsVerification: { value: answer.needsVerification ?? false, confidence: 1 },
              confirmed: { value: answer.confirmed, confidence: 1 },
              usage: { calls: 1, inputTokens: 0, outputTokens: 0 },
            };
          },
        }),
  };
}

export interface StubModelOptions {
  /** Text returned by every text generation. */
  text?: string | ((prompt: string) => string);
  /** JSON returned for structured generation, keyed by call order. */
  objects?: unknown[];
}

/**
 * A model that answers deterministically, so the whole loop runs without network access.
 */
export function stubModel(options: StubModelOptions = {}): LanguageModel {
  let objectIndex = 0;

  return new MockLanguageModelV3({
    doGenerate: async ({ prompt, responseFormat }) => {
      const wantsObject = responseFormat?.type === 'json';
      const text = wantsObject
        ? JSON.stringify(options.objects?.[objectIndex++] ?? {})
        : typeof options.text === 'function'
          ? options.text(JSON.stringify(prompt))
          : (options.text ?? 'Done.');

      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [] as [],
      };
    },
  });
}

export function userMessage(text: string, id = 'user-1'): AgentMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}
