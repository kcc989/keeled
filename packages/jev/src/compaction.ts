import { TypeSafeClient, noul } from '@typesafe-ai/sdk';
import type { JsonValue, Questions, Usage } from '@typesafe-ai/sdk';
import type { AgentMessage, Compactor, Observation, StateCheckpoint, UsageBucket } from '@keeled/core';
import {
  asToolPart,
  collectToolCalls,
  estimateTokens,
  fitState,
  json,
  pinRule,
  resultText,
  type CompactionCall,
  type CompactionState,
} from './compaction-state.ts';

/**
 * Compaction by Jev decisions instead of a summary: every finished tool call outside the
 * pinned messages is scored, stale results are truncated or removed together with their
 * call, and everything kept stays verbatim. Text and data parts are never touched.
 *
 * Ported from fast-jev-compaction (https://github.com/tamaratran/fast-jev-compaction, MIT).
 */

/** Anything that can answer compaction questions. Defaults to a `TypeSafeClient`. */
export interface CompactionAsker {
  ask(
    state: CompactionState,
    questions: Questions,
    abortSignal?: AbortSignal,
  ): Promise<{ answers: Readonly<Record<string, unknown>>; usage?: Usage }>;
}

export interface CompactionOptions {
  client?: TypeSafeClient;
  /** Jev model name. Defaults to the client's configured model. */
  model?: string;
  /** Replaces the client, for tests or a custom transport. */
  asker?: CompactionAsker;
  abortSignal?: AbortSignal;
  /** Ongoing task description; defaults to the last three user requests. */
  goal?: string;
  /** Minimum keep probability for a call or result to stay. Default 0.5. */
  keepThreshold?: number;
  /**
   * Newest messages never touched. A turn is usually a user message and one assistant
   * message, so the default of 2 keeps the latest exchange intact. The first message and the
   * open turn are always kept.
   */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Default 25000. */
  maxStateTokens?: number;
  /** Estimated token ceiling for state plus one batch of questions. Default 30000. */
  maxRequestTokens?: number;
  /** Characters of a dropped result to retain before its note. Default 300. */
  truncateHeadChars?: number;
}

interface ResolvedOptions {
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
}

export interface CallAnswer {
  /** Jev's probability that the call itself still matters. */
  keepCall: number;
  /** Jev's probability that the full result still needs to stay verbatim. */
  keepResult: number;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';

export interface CallDecision extends CallAnswer {
  id: string;
  toolCallId: string;
  tool: string;
  action: CallAction;
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped';
}

export interface CompactionResult {
  /** The compacted conversation; untouched messages are the input objects. */
  messages: AgentMessage[];
  decisions: CallDecision[];
  stats: {
    messagesBefore: number;
    messagesAfter: number;
    /** Serialised size of the conversation, in characters. */
    charsBefore: number;
    charsAfter: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    stateTokens: number;
    /** Which fitting stage the state needed, '' when no request was made. */
    stateStage: string;
    requests: number;
    usage: UsageBucket;
    ms: number;
  };
}

const defaults: ResolvedOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 2,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function resolveOptions(options: CompactionOptions): ResolvedOptions {
  return {
    goal: options.goal ?? defaults.goal,
    keepThreshold: finite(options.keepThreshold, defaults.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(finite(options.preserveRecentMessages, defaults.preserveRecentMessages)),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, defaults.maxStateTokens)),
    maxRequestTokens: Math.max(1, finite(options.maxRequestTokens, defaults.maxRequestTokens)),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, defaults.truncateHeadChars)),
    ),
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: CompactionCall): Questions {
  return {
    [`call_${call.id}`]: noul(
      `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the agent does next`,
    ),
    [`result_${call.id}`]: noul(
      `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the agent still needs its contents and running the tool again would not do`,
    ),
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the (always
 * complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly CompactionCall[],
  stateTokens: number,
  maxRequestTokens: number,
): CompactionCall[][] {
  const budget = maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: CompactionCall[][] = [];
  let current: CompactionCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `The compaction state leaves no room for questions (~${stateTokens} of ${maxRequestTokens} tokens).`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<CompactionCall, 'id' | 'toolCallId' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  keepThreshold: number,
): CallDecision {
  const base = { id: call.id, toolCallId: call.toolCallId, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= keepThreshold) return { ...base, action: 'keep', reason: 'kept' };
  if (answer.keepCall >= keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

function noulAnswer(answers: Readonly<Record<string, unknown>>, name: string): number {
  const answer = answers[name] as { noul?: unknown } | undefined;
  const value = answer?.noul;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid Jev answer for ${name}.`);
  }
  return value;
}

function clientAsker(client: TypeSafeClient, model: string | undefined): CompactionAsker {
  return {
    async ask(state, questions, abortSignal) {
      const result = await client.systemOne(
        {
          state: state as unknown as { [key: string]: JsonValue },
          questions,
          ...(model === undefined ? {} : { model }),
        },
        { signal: abortSignal },
      );
      return { answers: result.answers, usage: result.usage };
    },
  };
}

function truncatedResult(text: string, isError: boolean, headChars: number): string | undefined {
  if (text.length <= headChars + 120) return undefined;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[Compacted: ${text.length - headChars} chars of this tool ${
    isError ? 'error' : 'result'
  } were removed; run the tool again if needed.]`;
}

type Part = AgentMessage['parts'][number];

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears with its result.
 * A dropped result keeps a bounded head and a note: an output becomes that string, and an
 * error text is shortened. The checkpoint in message metadata gets the same treatment, since
 * it holds a copy of every tool output. Untouched messages are returned as the same objects;
 * a message left without parts is removed.
 */
export function applyDecisions(
  messages: readonly AgentMessage[],
  decisions: readonly CallDecision[],
  calls: readonly CompactionCall[],
  headChars: number,
): AgentMessage[] {
  const byId = new Map(calls.map(call => [call.id, call]));
  const byPosition = new Map<string, CallAction>();
  const byToolCallId = new Map<string, CallAction>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call === undefined || decision.action === 'keep') continue;
    byPosition.set(`${call.messageIndex}:${call.partIndex}`, decision.action);
    byToolCallId.set(call.toolCallId, decision.action);
  }

  const result: AgentMessage[] = [];
  messages.forEach((message, messageIndex) => {
    let changed = false;
    const parts: Part[] = [];
    message.parts.forEach((part, partIndex) => {
      const action = byPosition.get(`${messageIndex}:${partIndex}`);
      const tool = action === undefined ? undefined : asToolPart(part);
      if (action === undefined || tool === undefined) {
        parts.push(part);
        return;
      }
      if (action === 'drop_call') {
        changed = true;
        return;
      }
      const isError = tool.state === 'output-error';
      const text = truncatedResult(resultText(tool), isError, headChars);
      if (text === undefined) {
        parts.push(part);
        return;
      }
      changed = true;
      parts.push({ ...part, ...(isError ? { errorText: text } : { output: text }) } as Part);
    });

    const checkpoint = compactCheckpoint(message.metadata?.checkpoint, byToolCallId, headChars);
    if (!changed && checkpoint === message.metadata?.checkpoint) {
      result.push(message);
      return;
    }
    if (parts.length === 0) return;
    result.push({
      ...message,
      parts,
      ...(message.metadata === undefined ? {} : { metadata: { ...message.metadata, checkpoint } }),
    });
  });
  return result;
}

function compactCheckpoint(
  checkpoint: StateCheckpoint | undefined,
  actions: ReadonlyMap<string, CallAction>,
  headChars: number,
): StateCheckpoint | undefined {
  if (checkpoint === undefined) return undefined;
  let changed = false;
  const observations = checkpoint.state.observations.map((observation): Observation => {
    const action = actions.get(observation.id);
    if (action === undefined || observation.kind !== 'tool-result' || observation.detail === undefined) {
      return observation;
    }
    if (action === 'drop_call') {
      changed = true;
      const { detail: _detail, ...rest } = observation;
      return rest;
    }
    const text = truncatedResult(json(observation.detail), false, headChars);
    if (text === undefined) return observation;
    changed = true;
    return { ...observation, detail: text };
  });
  return changed ? { ...checkpoint, state: { ...checkpoint.state, observations } } : checkpoint;
}

/** The share of serialised characters compaction removed, from 0 to 1. */
export function reductionRatio(result: Pick<CompactionResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter(decision => decision.reason === reason).length;
}

/**
 * Compacts a conversation by asking Jev, for every finished tool call outside the pinned
 * messages, whether the call and whether its result must stay. The whole history (results
 * omitted, fitted into `maxStateTokens`) is sent as state with every batch of questions.
 *
 * Only closed turns are candidates, so reducing the compacted messages yields the same
 * execution state. Throws when Jev fails or the history cannot be fitted; the caller decides
 * whether to keep the original messages instead.
 */
export async function compactMessages(
  messages: readonly AgentMessage[],
  options: CompactionOptions = {},
): Promise<CompactionResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const pinned = pinRule(messages, resolved.preserveRecentMessages);
  const calls = collectToolCalls(messages, pinned);
  const candidates = calls.filter(call => !call.pinned);
  const usage: UsageBucket = { calls: 0, inputTokens: 0, outputTokens: 0 };

  let fitted = { tokens: 0, stage: '' };
  let batches: CompactionCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const asker =
      options.asker ?? clientAsker(options.client ?? new TypeSafeClient(), options.model);
    const state = fitState(messages, calls, {
      maxStateTokens: resolved.maxStateTokens,
      goal: resolved.goal,
      pinned,
    });
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved.maxRequestTokens);
    const responses = await Promise.all(
      batches.map(async batch => {
        const questions: Questions = Object.assign({}, ...batch.map(questionsFor));
        const response = await asker.ask(state.state, questions, options.abortSignal);
        return { batch, response };
      }),
    );
    for (const { batch, response } of responses) {
      usage.calls += 1;
      usage.inputTokens += response.usage?.input_tokens ?? 0;
      usage.outputTokens += response.usage?.output_tokens ?? 0;
      for (const call of batch) {
        answers.set(call.id, {
          keepCall: noulAnswer(response.answers, `call_${call.id}`),
          keepResult: noulAnswer(response.answers, `result_${call.id}`),
        });
      }
    }
  }

  const decisions = calls.map(call =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved.keepThreshold),
  );
  const compacted = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars);
  return {
    messages: compacted,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: compacted.length,
      charsBefore: json(messages).length,
      charsAfter: json(compacted).length,
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      usage,
      ms: Date.now() - started,
    },
  };
}

export interface JevCompactorOptions extends Omit<CompactionOptions, 'abortSignal'> {
  /** Keep the history unchanged unless compaction removes at least this share. Default 0.25. */
  minReduction?: number;
}

/**
 * A compactor for `createAgent({ compaction: { compactor: jevCompactor() } })`. When the
 * reduction falls under `minReduction`, the history is kept unchanged.
 */
export function jevCompactor(options: JevCompactorOptions = {}): Compactor {
  const minReduction = finite(options.minReduction, 0.25);
  return async (messages, { abortSignal }) => {
    const result = await compactMessages(messages, { ...options, abortSignal });
    const ratio = reductionRatio(result);
    const { kept, resultsDropped, callsDropped } = result.stats;
    const counts = `Jev kept ${kept}, truncated ${resultsDropped}, and removed ${callsDropped} tool calls.`;
    if (ratio < minReduction) {
      return {
        messages: [...messages],
        usage: result.stats.usage,
        detail: `${counts} The ${Math.round(ratio * 100)}% reduction is under the minimum, so the history is unchanged.`,
      };
    }
    return { messages: result.messages, usage: result.stats.usage, detail: counts };
  };
}
