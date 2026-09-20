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

export interface TestFixtureSource {}

/** Convert deliberately malformed or partial test data to the contract under test. */
export function testFixture<T>(value: TestFixtureSource): T {
  // SAFETY: callers use this only to exercise validation and compatibility boundaries in tests.
  return value as T;
}

export type ScriptedDecision =
  | NextAction
  | ControllerDecision
  | ((context: ControllerContext) => NextAction | ControllerDecision);

export interface ScriptedControllerOptions {
  decisions: ScriptedDecision[];
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

  const controller: Controller & { readonly consumed: number; readonly contexts: ControllerContext[] } = {
    name: 'scripted',
    get consumed() {
      return index;
    },
    get contexts() {
      return contexts;
    },
    async control(context: ControllerContext): Promise<ControlResult> {
      contexts.push(context);
      const entry = options.decisions[index];

      const resolved =
        entry === undefined
          ? (options.fallback ?? { type: 'respond' as const, outcome: 'blocked' as const })
          : isScriptedDecision(entry)
            ? entry(context)
            : entry;

      const decision: ControllerDecision = 'action' in resolved ? resolved : { action: resolved };

      index += 1;

      return {
        confidence: 1,
        ...decision,
        usage: { calls: 1, inputTokens: 0, outputTokens: 0 },
      };
    },
  };

  if (options.authorize !== undefined)
    controller.authorize = async (context: ControllerContext, action: PendingAction): Promise<Authorization> => {
      const answer = options.authorize!(action, context);

      return {
        permitted: { value: answer.permitted, confidence: 1 },
        needsVerification: { value: answer.needsVerification ?? false, confidence: 1 },
        confirmed: { value: answer.confirmed, confidence: 1 },
        usage: { calls: 1, inputTokens: 0, outputTokens: 0 },
      };
    };

  return controller;
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
        : isTextFactory(options.text)
          ? options.text(JSON.stringify(prompt))
          : (options.text ?? 'Done.');

      return {
        content: [{ type: 'text' as const, text }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        // SAFETY: the adjacent validation or framework contract establishes the asserted type.
        warnings: [] as [],
      };
    },
  });
}

function isScriptedDecision(
  value: ScriptedDecision,
): value is (context: ControllerContext) => NextAction | ControllerDecision {
  return typeof value === 'function';
}

function isTextFactory(value: StubModelOptions['text']): value is (prompt: string) => string {
  return typeof value === 'function';
}

export function userMessage(text: string, id = 'user-1'): AgentMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}
