import { wrapLanguageModel, type LanguageModel } from 'ai';
import {
  createAgent,
  evidenceTool,
  evidenceCalculationTool,
  modelTaskTracker,
  type AccessControl,
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
  kind: 'control' | 'authorize' | 'generate';
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
  /** Set by the trusted host, never by the session request body. */
  access?: AccessControl;
  /** Defaults on; disable only for tests with scripted task state. */
  trackTasks?: boolean;
  model: LanguageModel;
  /** Model used to fill in tool arguments. Defaults to `model`. */
  argumentsModel?: LanguageModel;
  /** Model used for state-changing tool arguments. Defaults to `argumentsModel`. */
  writeArgumentsModel?: LanguageModel;
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
      access: options.access,
      taskTracker: options.trackTasks === false ? undefined : modelTaskTracker(),
      controller: observe(options.controller, trace, decision => this.#decisions.push(logOf(decision))),
      model: timed(options.model, trace),
      tools: {
        ...bridgeTools(
          options.tools,
          (call, signal) => this.#requestTool(call, signal),
          options.argumentsModel === undefined ? undefined : timed(options.argumentsModel, trace),
          options.writeArgumentsModel === undefined ? undefined : timed(options.writeArgumentsModel, trace),
        ),
        evidence: evidenceTool(),
        arithmetic: evidenceCalculationTool(),
      },
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
        this.#emit({ type: 'message', text: result.text.trim() || `The turn ended with status ${result.stopReason}; no response text was produced.`, stopReason: result.stopReason, usage: result.usage });
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
    async control(context) {
      const started = performance.now();
      const result = await controller.control(context);
      trace({
        kind: 'control',
        ms: Math.round(performance.now() - started),
        detail: { action: result.action },
      });
      onDecision(result);
      return result;
    },
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
