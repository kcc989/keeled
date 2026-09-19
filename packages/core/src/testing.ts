import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type {
  Controller,
  ControllerContext,
  ControllerDecision,
  NextAction,
  ProgressAssessment,
} from './controller.ts';
import type { AgentMessage } from './types.ts';

export interface ScriptedAssessment {
  steps?: Record<string, { complete: boolean; confidence?: number }>;
  goalMet?: boolean;
  goalConfidence?: number;
  planValid?: boolean;
  planValidConfidence?: number;
}

export type ScriptedDecision =
  | NextAction
  | ((context: ControllerContext) => NextAction | ControllerDecision);

export interface ScriptedControllerOptions {
  decisions: ScriptedDecision[];
  assess?: ScriptedAssessment | ((context: ControllerContext) => ScriptedAssessment);
  /** Action used once the script runs out. Defaults to responding `blocked`. */
  fallback?: NextAction;
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
    async decide(context: ControllerContext): Promise<ControllerDecision> {
      contexts.push(context);
      const entry = options.decisions[index];
      index += 1;
      if (entry === undefined) {
        return { action: options.fallback ?? { type: 'respond', outcome: 'blocked' } };
      }
      const resolved = typeof entry === 'function' ? entry(context) : entry;
      const decision: ControllerDecision =
        'action' in resolved ? resolved : { action: resolved };
      return { confidence: 1, usage: { calls: 1, inputTokens: 0, outputTokens: 0 }, ...decision };
    },
    async assess(context: ControllerContext): Promise<ProgressAssessment> {
      const source =
        typeof options.assess === 'function' ? options.assess(context) : (options.assess ?? {});
      const steps: ProgressAssessment['steps'] = {};
      for (const step of context.plan?.steps ?? []) {
        const entry = source.steps?.[step.id];
        steps[step.id] = {
          complete: entry?.complete ?? false,
          confidence: entry?.confidence ?? 1,
        };
      }
      return {
        steps,
        goalMet: { complete: source.goalMet ?? false, confidence: source.goalConfidence ?? 1 },
        planValid: { valid: source.planValid ?? true, confidence: source.planValidConfidence ?? 1 },
        usage: { calls: 1, inputTokens: 0, outputTokens: 0 },
      };
    },
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
