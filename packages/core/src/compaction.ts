import { errorMessage } from './errors.ts';
import type { AgentMessage, ManagedGeneration, TransitionRecord, UsageBucket } from './types.ts';

export interface CompactionContext {
  abortSignal: AbortSignal;
  /** Managed text generation: usage counts toward the turn, with its timeout and cancellation. */
  generateText: ManagedGeneration['generateText'];
}

export interface CompactionOutcome {
  /** The history to run the turn on. Returning the input unchanged is allowed. */
  messages: AgentMessage[];
  /** Controller usage spent on compaction. */
  usage?: UsageBucket;
  /** A short description recorded with the compaction transition. */
  detail?: string;
}

/**
 * Shrinks the history before a turn. The runtime reduces state from the returned messages, so
 * a compactor must leave the open turn (every part after the last terminal transition) intact.
 */
export type Compactor = (
  messages: readonly AgentMessage[],
  context: CompactionContext,
) => Promise<CompactionOutcome>;

export interface CompactionConfig {
  compactor: Compactor;
  /** Compact only when the serialised history exceeds this many characters. Default 100000. */
  thresholdChars?: number;
}

export interface ResolvedCompaction {
  compactor: Compactor;
  thresholdChars: number;
}

export interface CompactedHistory {
  messages: AgentMessage[];
  /** Absent when the history was under the threshold and compaction did not run. */
  transition?: { detail: string };
  usage?: UsageBucket;
}

/**
 * Runs the configured compactor when the history is over the threshold. A failure never ends
 * the turn: the full history is kept and the failure is reported in the transition.
 */
export async function compactHistory(
  compaction: ResolvedCompaction | undefined,
  messages: AgentMessage[],
  context: CompactionContext,
): Promise<CompactedHistory> {
  if (compaction === undefined) return { messages };
  const before = serializedLength(messages);
  if (before <= compaction.thresholdChars) return { messages };

  try {
    const outcome = await compaction.compactor(messages, context);
    const after = serializedLength(outcome.messages);
    const summary = `Compacted the history from ${before} to ${after} characters.`;
    return {
      messages: [...outcome.messages],
      usage: outcome.usage,
      transition: { detail: outcome.detail === undefined ? summary : `${summary} ${outcome.detail}` },
    };
  } catch (error) {
    return {
      messages,
      transition: { detail: `Compaction failed; the full history was kept. ${errorMessage(error)}` },
    };
  }
}

/**
 * Where the reducer's current turn begins: just after the last terminal transition. Parts
 * from there on are still reduced into execution state, so a compactor must leave them alone.
 * Undefined when no turn has finished, so the whole history is one open turn.
 */
export function openTurnStart(
  messages: readonly AgentMessage[],
): { message: number; part: number } | undefined {
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const message = messages[m];
    if (message?.role !== 'assistant') continue;
    for (let p = message.parts.length - 1; p >= 0; p -= 1) {
      const part = message.parts[p];
      if (part?.type !== 'data-transition') continue;
      if ((part as { data: TransitionRecord }).data.stopReason !== undefined) {
        return { message: m, part: p + 1 };
      }
    }
  }
  return undefined;
}

function serializedLength(messages: readonly AgentMessage[]): number {
  try {
    return JSON.stringify(messages).length;
  } catch {
    return 0;
  }
}
