import type { ModelMessage } from 'ai';
import type { AgentMessage, Blocker, ExecutionState, Observation } from './types.ts';
import type { AwaitingAction } from './controller.ts';
import { stableHash } from './ids.ts';
import { type JsonObject, type JsonValue } from './json.ts';

/**
 * Explicit projection of conversation history for model calls.
 *
 * Only text carries into model messages. Tool evidence and operational transitions
 * reach the model through a compact digest, so that a partially assembled tool part
 * can never produce an unpaired tool call in the prompt.
 */
export function projectMessages(conversation: readonly AgentMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const message of conversation) {
    if (message.role === 'system') continue;

    const text = message.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim();

    if (text.length === 0) continue;
    messages.push({ role: message.role === 'user' ? 'user' : 'assistant', content: text });
  }

  return messages;
}

export function latestRequest(conversation: readonly AgentMessage[]): string {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];

    if (message?.role !== 'user') continue;

    const text = message.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('')
      .trim();

    if (text.length > 0) return text;
  }

  return '';
}

export function digestObservations(observations: readonly Observation[], limit = 12): string {
  if (observations.length === 0) return 'No tool evidence yet.';

  return observations
    .slice(-limit)
    .map((observation) => {
      const scope = observation.tool === undefined ? '' : ` [${observation.tool}]`;

      const detail = observation.detail === undefined ? '' : ` ${json(observation.detail)}`;

      return `- (${observation.kind})${scope} ${observation.summary}${detail}`;
    })
    .join('\n');
}

export function digestState(state: Readonly<ExecutionState>): JsonObject {
  return {
    cycle: state.cycle,
    stepsUsed: state.stepsUsed,
    toolCalls: state.toolCalls,
    blockers: state.blockers.slice(-4).map((blocker) => blocker.reason),
  };
}

/** One completed tool call, with the input it was made with and what it returned. */
export interface CallRecord {
  /** The call's id, which is also the stable reference to its complete result. */
  ref: string;
  turn: 'earlier' | 'current';
  tool: string;
  input: JsonValue;
  outcome: 'result' | 'error';
  result: JsonValue;
}

interface ToolPartLike {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: JsonValue;
  output?: JsonValue;
  errorText?: string;
}

/**
 * Every completed tool call in the conversation, each exactly once, in order. The current
 * turn's calls come from the reduced observations and are marked current; the persisted
 * parts supply earlier turns. A part whose call id the observations already hold belongs to
 * the message being written for this turn, so it is not projected again.
 */
export function callHistory(conversation: readonly AgentMessage[], observations: readonly Observation[]): CallRecord[] {
  const current = new Set(
    observations.flatMap((observation) =>
      observation.kind === 'tool-result' || observation.kind === 'tool-error' ? [observation.id] : [],
    ),
  );

  const seen = new Set<string>();
  const history: CallRecord[] = [];

  for (const message of conversation) {
    if (message.role !== 'assistant') continue;

    // SAFETY: only tool-prefixed message parts are read, and every accessed field is optional.
    for (const part of message.parts as ToolPartLike[]) {
      if (!part.type.startsWith('tool-') || part.toolCallId === undefined) continue;

      if (current.has(part.toolCallId) || seen.has(part.toolCallId)) continue;
      const tool = part.type.slice('tool-'.length);
      const base = { ref: part.toolCallId, turn: 'earlier' as const, tool, input: part.input ?? null };

      if (part.state === 'output-available') {
        seen.add(part.toolCallId);
        history.push({ ...base, outcome: 'result', result: part.output ?? null });
      } else if (part.state === 'output-error') {
        seen.add(part.toolCallId);
        history.push({ ...base, outcome: 'error', result: part.errorText ?? 'Unknown tool error.' });
      }
    }
  }

  for (const observation of observations) {
    if (observation.kind !== 'tool-result' && observation.kind !== 'tool-error') continue;
    const failed = observation.kind === 'tool-error';
    history.push({
      ref: observation.id,
      turn: 'current',
      tool: observation.tool ?? 'unknown',
      input: observation.input ?? null,
      outcome: failed ? 'error' : 'result',
      result: failed ? observation.summary : (observation.detail ?? null),
    });
  }

  return history;
}

/**
 * Actions held for the user's confirmation that have not run since, across turns. A held
 * action is recorded as a confirmation blocker; a later successful call of the same tool
 * with the same input releases it.
 */
export function awaitingConfirmation(conversation: readonly AgentMessage[]): AwaitingAction[] {
  const pending = new Map<string, AwaitingAction>();

  for (const message of conversation) {
    if (message.role !== 'assistant') continue;

    // SAFETY: blocker and tool fields are checked before use; unrelated message parts are skipped.
    for (const part of message.parts as (ToolPartLike & { data?: Blocker })[]) {
      if (part.type === 'data-blocker' && part.data?.kind === 'needs_confirmation' && part.data.tool !== undefined) {
        const key = stableHash({ tool: part.data.tool, input: part.data.input });
        pending.set(key, {
          tool: part.data.tool,
          input: part.data.input,
          reason: part.data.reason,
        });
      } else if (part.type.startsWith('tool-') && part.state === 'output-available') {
        pending.delete(stableHash({ tool: part.type.slice('tool-'.length), input: part.input }));
      }
    }
  }

  return [...pending.values()];
}

function json(value: JsonValue): string {
  return JSON.stringify(value) ?? 'null';
}
