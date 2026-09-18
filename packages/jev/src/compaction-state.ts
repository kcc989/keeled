import { openTurnStart, type AgentMessage } from '@keeled/core';

/**
 * The Jev state for compaction, and how it is fitted into a token budget.
 *
 * Ported from fast-jev-compaction (https://github.com/tamaratran/fast-jev-compaction, MIT),
 * adapted to AI SDK UI messages, where a tool call and its result share one tool part.
 */

type Part = AgentMessage['parts'][number];

/** A finished tool part: a call together with its output or error. */
export interface CompactionCall {
  /** Short id used in the Jev state and question names (`t1`, `t2`, ...). */
  id: string;
  toolCallId: string;
  tool: string;
  input: unknown;
  messageIndex: number;
  partIndex: number;
  resultChars: number;
  isError: boolean;
  /** Never a candidate: in the first or newest messages, or in the open turn. */
  pinned: boolean;
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

export interface HistoryEntry {
  i: number;
  role: AgentMessage['role'];
  text: string;
  /** Structured per call, or one compact line per call once the state has to shrink. */
  tool_calls?: HistoryToolCall[] | string[];
}

/** The state sent with every Jev request: the whole history, results omitted. */
export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  /** Which fitting stage produced the state, for diagnostics. */
  stage: string;
}

export const STATE_CONTEXT =
  'An agent conversation is being compacted to reduce its size. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the agent can always run a tool again.';

/** Successive caps on the serialised tool input included per call. */
const INPUT_CHARS = [1000, 200, 60] as const;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

/**
 * Estimates tokens without a tokenizer: a word costs one token per six letters, a digit half
 * a token, any other symbol nine tenths. The reference calibrated this against the usage Jev
 * reports, where it lands a little above the true count; a plain characters-per-token ratio
 * undercounts JSON-heavy states.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

export function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable]';
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`;
}

export function messageText(message: AgentMessage): string {
  return message.parts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .join('');
}

export interface ToolPartLike {
  type: string;
  toolCallId: string;
  toolName?: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

export function asToolPart(part: Part): ToolPartLike | undefined {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
    ? (part as unknown as ToolPartLike)
    : undefined;
}

/** The text a tool part holds as its result: the serialised output, or the error text. */
export function resultText(part: ToolPartLike): string {
  return part.state === 'output-error' ? (part.errorText ?? '') : json(part.output);
}

/** Whether a position must stay untouched: first message, newest messages, or the open turn. */
export type PinRule = (messageIndex: number, partIndex?: number) => boolean;

export function pinRule(messages: readonly AgentMessage[], preserveRecentMessages: number): PinRule {
  const open = openTurnStart(messages);
  const recent = messages.length - preserveRecentMessages;
  return (messageIndex, partIndex = Number.POSITIVE_INFINITY) => {
    if (messageIndex === 0 || messageIndex >= recent) return true;
    // Without any terminal transition the whole history is one open turn.
    if (open === undefined) return true;
    if (messageIndex > open.message) return true;
    return messageIndex === open.message && partIndex >= open.part;
  };
}

/** Every finished tool part, in order. Parts still waiting for a result are not candidates. */
export function collectToolCalls(
  messages: readonly AgentMessage[],
  pinned: PinRule,
): CompactionCall[] {
  const calls: CompactionCall[] = [];
  messages.forEach((message, messageIndex) => {
    message.parts.forEach((raw, partIndex) => {
      const part = asToolPart(raw);
      if (part === undefined) return;
      if (part.state !== 'output-available' && part.state !== 'output-error') return;
      calls.push({
        id: `t${calls.length + 1}`,
        toolCallId: part.toolCallId,
        tool: part.type === 'dynamic-tool' ? (part.toolName ?? 'unknown') : part.type.slice('tool-'.length),
        input: part.input,
        messageIndex,
        partIndex,
        resultChars: resultText(part).length,
        isError: part.state === 'output-error',
        pinned: pinned(messageIndex, partIndex),
      });
    });
  });
  return calls;
}

function resultNote(call: CompactionCall): string {
  return `${call.isError ? 'error' : 'ok'}, ${call.resultChars} chars (omitted)`;
}

/** One call as a single line, for when the structured form is too costly. */
function compactCall(call: CompactionCall): string {
  const input =
    call.input !== null && typeof call.input === 'object' && !Array.isArray(call.input)
      ? Object.entries(call.input as Record<string, unknown>)
          .map(([key, value]) => {
            const text = typeof value === 'string' ? value : truncate(json(value), 200);
            return `${key}=${text.replace(/\s+/g, ' ')}`;
          })
          .join(' ')
      : json(call.input);
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${
    call.isError ? 'error' : 'ok'
  } ${call.resultChars}ch`;
}

function callsByMessage(calls: readonly CompactionCall[]): Map<number, CompactionCall[]> {
  const byMessage = new Map<number, CompactionCall[]>();
  for (const call of calls) {
    const list = byMessage.get(call.messageIndex) ?? [];
    list.push(call);
    byMessage.set(call.messageIndex, list);
  }
  return byMessage;
}

function historyEntries(
  messages: readonly AgentMessage[],
  calls: readonly CompactionCall[],
  inputChars: number,
): HistoryEntry[] {
  const byMessage = callsByMessage(calls);
  const entries: HistoryEntry[] = [];
  messages.forEach((message, i) => {
    if (message.role === 'system') return;
    const text = messageText(message);
    const toolCalls = (byMessage.get(i) ?? []).map(call => ({
      id: call.id,
      tool: call.tool,
      input: truncate(json(call.input), inputChars),
      result: resultNote(call),
    }));
    if (text.trim().length === 0 && toolCalls.length === 0) return;
    const entry: HistoryEntry = { i, role: message.role, text };
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    entries.push(entry);
  });
  return entries;
}

/**
 * Folds runs of adjacent call-only entries into one entry each, so the per-entry envelope is
 * paid once per run; the call lines keep their ids.
 */
function mergeCallRuns(
  history: readonly HistoryEntry[],
  pinned: (entry: HistoryEntry) => boolean,
): HistoryEntry[] {
  const foldable = (entry: HistoryEntry): boolean =>
    !pinned(entry) && entry.text.length === 0 && typeof entry.tool_calls?.[0] === 'string';
  const merged: HistoryEntry[] = [];
  for (const entry of history) {
    const previous = merged[merged.length - 1];
    if (previous && foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [...(previous.tool_calls as string[]), ...(entry.tool_calls as string[])];
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

/** The last three user requests, as the default `goal`. */
export function goalFromMessages(messages: readonly AgentMessage[]): string {
  return messages
    .filter(message => message.role === 'user')
    .map(messageText)
    .filter(text => text.trim().length > 0)
    .slice(-3)
    .map(text => truncate(text, 500))
    .join('\n');
}

/**
 * Builds the Jev state from the whole conversation and shrinks it in stages until it fits
 * `maxStateTokens`: tool inputs are truncated, then long texts are abridged oldest-first
 * (pinned messages last), then old messages collapse to a one-line note, then old tool calls
 * shrink to one line each, then old messages that carry no call are left out, then runs of
 * old call-only messages are folded into one entry. Throws when even that is too big.
 */
export function fitState(
  messages: readonly AgentMessage[],
  calls: readonly CompactionCall[],
  options: { maxStateTokens: number; goal: string; pinned: PinRule },
): FittedState {
  const goal = options.goal || goalFromMessages(messages);
  const stateOf = (history: HistoryEntry[]): CompactionState => ({
    context: STATE_CONTEXT,
    goal,
    history,
  });
  const entryTokens = (entry: HistoryEntry): number => estimateTokens(JSON.stringify(entry)) + 1;
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])));
  const fitted = (history: HistoryEntry[], tokens: number, stage: string): FittedState => ({
    state: stateOf(history),
    tokens,
    stage,
  });

  let history: HistoryEntry[] = [];
  let perEntry: number[] = [];
  let tokens = 0;
  const rebuild = (inputChars: number): void => {
    history = historyEntries(messages, calls, inputChars);
    perEntry = history.map(entryTokens);
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  };
  const fits = (): boolean => tokens <= options.maxStateTokens;
  const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
    const entry = history[index];
    if (!entry) return;
    change(entry);
    const now = entryTokens(entry);
    tokens += now - (perEntry[index] ?? 0);
    perEntry[index] = now;
  };

  rebuild(INPUT_CHARS[0]);
  if (fits()) return fitted(history, tokens, 'full');

  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit);
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
  }

  const pinned = (entry: HistoryEntry): boolean => options.pinned(entry.i);
  const indices = history.map((_, index) => index);
  const order = [
    ...indices.filter(index => !pinned(history[index]!)),
    ...indices.filter(index => pinned(history[index]!)),
  ];

  for (const index of order) {
    const entry = history[index]!;
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    shrink(index, e => {
      e.text = abridge(e.text, TEXT_HEAD, TEXT_TAIL);
    });
    if (fits()) return fitted(history, tokens, 'texts abridged');
  }

  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.text.length === 0) continue;
    const message = messages[entry.i];
    const original = message === undefined ? entry.text.length : messageText(message).length;
    shrink(index, e => {
      e.text = `[… ${original} chars omitted …]`;
    });
    if (fits()) return fitted(history, tokens, 'old messages collapsed');
  }

  const byMessage = callsByMessage(calls);
  for (const index of order) {
    const entry = history[index]!;
    const own = byMessage.get(entry.i);
    if (pinned(entry) || !own) continue;
    shrink(index, e => {
      e.tool_calls = own.map(compactCall);
    });
    if (fits()) return fitted(history, tokens, 'old calls compacted');
  }

  const left = new Set<number>();
  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.tool_calls) continue;
    left.add(index);
    tokens -= perEntry[index] ?? 0;
    if (fits()) {
      return fitted(
        history.filter((_, i) => !left.has(i)),
        tokens,
        'old messages left out',
      );
    }
  }

  history = mergeCallRuns(
    history.filter((_, i) => !left.has(i)),
    pinned,
  );
  perEntry = history.map(entryTokens);
  tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  if (fits()) return fitted(history, tokens, 'old calls merged');

  throw new Error(
    `History too large for Jev (~${tokens} tokens after fitting, limit ${options.maxStateTokens}).`,
  );
}
