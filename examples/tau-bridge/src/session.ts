import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { TypeSafeClient } from '@typesafe-ai/sdk';
import {
  createAgent,
  evidenceTool,
  planningTool,
  type Agent,
  type AgentMessage,
  type AgentPolicy,
  type AgentToolSet,
  type Controller,
  type ControllerContext,
  type ControllerDecision,
  type NextAction,
  type PendingAction,
  type StopReason,
  type UsageTotals,
} from '@keeled/core';
import { bridgeTools, respondWith, type ToolCallRequest, type ToolSpec } from './tools.ts';

export interface DecisionLog {
  action: NextAction;
  rationale?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface TraceEntry {
  kind: 'assess' | 'decide' | 'authorize' | 'review' | 'generate';
  ms: number;
  detail?: unknown;
}

export type BridgeEvent =
  | ({ type: 'tool_call'; decisions: DecisionLog[]; trace: TraceEntry[] } & ToolCallRequest)
  | {
      type: 'message';
      text: string;
      stopReason: StopReason;
      usage: UsageTotals;
      decisions: DecisionLog[];
      trace: TraceEntry[];
    };

type WithoutLogs<E> = E extends unknown ? Omit<E, 'decisions' | 'trace'> : never;
type PendingEvent = WithoutLogs<BridgeEvent>;

export interface ToolResult {
  id: string;
  content: string;
  error?: boolean;
}

export interface SessionOptions {
  instructions: string;
  tools: ToolSpec[];
  history?: { role: 'user' | 'assistant'; text: string }[];
  controller: Controller;
  model: LanguageModel;
  /** Model used to fill in tool arguments. Defaults to `model`. */
  argumentsModel?: LanguageModel;
  /** Model used for state-changing tool arguments. Defaults to `argumentsModel`. */
  writeArgumentsModel?: LanguageModel;
  /** Lets Jev confirm arguments that have exactly one known value, skipping the model. */
  argumentClient?: TypeSafeClient;
  policy?: AgentPolicy;
}

export class SessionConflictError extends Error {}

/**
 * One conversation, driven a turn at a time. A turn runs the unmodified Keeled loop; when
 * it calls a tool, the call is surfaced as an event and the tool's promise stays open
 * until the caller supplies the result.
 */
export class Session {
  readonly #agent: Agent<AgentToolSet>;
  readonly #abort = new AbortController();
  #messages: AgentMessage[];
  #decisions: DecisionLog[] = [];
  #trace: TraceEntry[] = [];
  #pending: { id: string; resolve(value: unknown): void; reject(error: unknown): void } | undefined;
  #waiter: { resolve(event: BridgeEvent): void; reject(error: unknown): void } | undefined;
  #running = false;

  constructor(options: SessionOptions) {
    this.#messages = (options.history ?? []).map(entry => textMessage(entry.role, entry.text));
    const trace = (entry: TraceEntry) => this.#trace.push(entry);
    this.#agent = createAgent({
      instructions: options.instructions,
      controller: observe(options.controller, trace, decision => this.#decisions.push(logOf(decision))),
      model: timed(options.model, trace),
      tools: {
        ...bridgeTools(
          options.tools,
          (call, signal) => this.#requestTool(call, signal),
          options.argumentsModel === undefined ? undefined : timed(options.argumentsModel, trace),
          options.writeArgumentsModel === undefined ? undefined : timed(options.writeArgumentsModel, trace),
          options.argumentClient,
        ),
        // Both run locally and are never sent to the remote side: one reads stored results,
        // the other states objectives that selected actions then carry.
        evidence: evidenceTool(),
        plan: planningTool(),
      },
      planningTool: 'plan',
      respond: respondWith(
        options.tools,
        options.argumentsModel === undefined ? undefined : timed(options.argumentsModel, trace),
      ),
      policy: options.policy,
    });
  }

  /** The persisted conversation. Execution state is always derived from it by the reducer. */
  get messages(): readonly AgentMessage[] {
    return this.#messages;
  }

  sendUser(text: string): Promise<BridgeEvent> {
    if (this.#running) throw new SessionConflictError('A turn is already in progress.');
    this.#messages = [...this.#messages, textMessage('user', text)];
    this.#running = true;
    const next = this.#nextEvent();

    this.#agent.run({ messages: this.#messages, abortSignal: this.#abort.signal }).then(
      result => {
        this.#messages = result.messages;
        this.#running = false;
        this.#emit({ type: 'message', text: result.text, stopReason: result.stopReason, usage: result.usage });
      },
      error => {
        this.#running = false;
        const waiter = this.#waiter;
        this.#waiter = undefined;
        waiter?.reject(error);
      },
    );
    return next;
  }

  sendToolResult(result: ToolResult): Promise<BridgeEvent> {
    const pending = this.#pending;
    if (pending === undefined || pending.id !== result.id) {
      throw new SessionConflictError(`No pending tool call with id "${result.id}".`);
    }
    this.#pending = undefined;
    const next = this.#nextEvent();
    if (result.error === true) pending.reject(new Error(result.content));
    else pending.resolve(parseContent(result.content));
    return next;
  }

  close(): void {
    this.#abort.abort();
  }

  #requestTool(call: ToolCallRequest, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      this.#pending = { id: call.id, resolve, reject };
      this.#emit({ type: 'tool_call', ...call });
    });
  }

  #nextEvent(): Promise<BridgeEvent> {
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  #emit(event: PendingEvent): void {
    const waiter = this.#waiter;
    const decisions = this.#decisions;
    const trace = this.#trace;
    this.#waiter = undefined;
    this.#decisions = [];
    this.#trace = [];
    waiter?.resolve({ ...event, decisions, trace } as BridgeEvent);
  }
}

function observe(
  controller: Controller,
  trace: (entry: TraceEntry) => void,
  onDecision: (decision: ControllerDecision) => void,
): Controller {
  return {
    name: controller.name,
    async assess(context) {
      const started = performance.now();
      const assessment = await controller.assess(context);
      trace({
        kind: 'assess',
        ms: Math.round(performance.now() - started),
        detail: { goalMet: assessment.goalMet, steps: assessment.steps },
      });
      return assessment;
    },
    async decide(context) {
      const started = performance.now();
      const decision = await controller.decide(context);
      trace({ kind: 'decide', ms: Math.round(performance.now() - started) });
      onDecision(decision);
      return decision;
    },
    ...(controller.reviewReply === undefined
      ? {}
      : {
          async reviewReply(context: ControllerContext, reply: string) {
            const started = performance.now();
            const review = await controller.reviewReply!(context, reply);
            trace({
              kind: 'review',
              ms: Math.round(performance.now() - started),
              detail: { addressesRequest: review.addressesRequest, supported: review.supported },
            });
            return review;
          },
        }),
    ...(controller.authorize === undefined
      ? {}
      : {
          async authorize(context: ControllerContext, action: PendingAction) {
            const started = performance.now();
            const answer = await controller.authorize!(context, action);
            trace({
              kind: 'authorize',
              ms: Math.round(performance.now() - started),
              detail: {
                tool: action.tool,
                input: action.input,
                permitted: answer.permitted,
                needsVerification: answer.needsVerification,
                confirmed: answer.confirmed,
              },
            });
            return answer;
          },
        }),
  };
}

function timed(model: LanguageModel, trace: (entry: TraceEntry) => void): LanguageModel {
  if (typeof model === 'string') return model;
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]['model'],
    middleware: {
      specificationVersion: 'v3',
      async wrapGenerate({ doGenerate, params }) {
        const started = performance.now();
        const result = await doGenerate();
        trace({
          kind: 'generate',
          ms: Math.round(performance.now() - started),
          detail: {
            structured: params.responseFormat?.type === 'json',
            outputTokens: result.usage.outputTokens.total,
            reasoningTokens: result.usage.outputTokens.reasoning,
          },
        });
        return result;
      },
    },
  });
}

function logOf(decision: ControllerDecision): DecisionLog {
  return {
    action: decision.action,
    rationale: decision.rationale,
    confidence: decision.confidence,
    probabilities: decision.probabilities,
  };
}

function textMessage(role: 'user' | 'assistant', text: string): AgentMessage {
  return { id: crypto.randomUUID(), role, parts: [{ type: 'text', text }] };
}

function parseContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}
