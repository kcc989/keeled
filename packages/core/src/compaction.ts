import { errorMessage } from './errors.ts';
import { canonicalJson, createId } from './ids.ts';
import { reduceState } from './state.ts';
import type {
  AgentMessage,
  CompactionEdit,
  CompactionRecord,
  ExecutionState,
  ManagedGeneration,
  Observation,
  StateCheckpoint,
  ToolPartEdit,
  TransitionRecord,
  UsageBucket,
} from './types.ts';

/**
 * Non-destructive compaction. Stored messages are never rewritten: a compactor returns an
 * edit, the runtime records it as a `data-compaction` part, and `compactedView` applies the
 * recorded edits whenever the history is read. The host keeps the full history.
 */

export interface CompactionContext {
  abortSignal: AbortSignal;
  /** Managed text generation: usage counts toward the turn, with its timeout and cancellation. */
  generateText: ManagedGeneration['generateText'];
}

export interface CompactionOutcome {
  /** The edit to apply to the view. Omit it to leave the view as it is. */
  edit?: CompactionEdit;
  /** Controller usage spent on compaction. */
  usage?: UsageBucket;
  /** A short description recorded with the compaction. */
  detail?: string;
}

/**
 * Proposes an edit to the current view of the history. The edit must leave the open turn
 * (every part after the last terminal transition) intact; the runtime rejects one that does
 * not.
 */
export type Compactor = (
  view: readonly AgentMessage[],
  context: CompactionContext,
) => Promise<CompactionOutcome>;

export interface CompactionConfig {
  compactor: Compactor;
  /** Compact only when the serialised view exceeds this many characters. Default 100000. */
  thresholdChars?: number;
}

export interface ResolvedCompaction {
  compactor: Compactor;
  thresholdChars: number;
}

export interface PreparedHistory {
  /** What the turn runs on: the stored history with every recorded edit applied. */
  view: AgentMessage[];
  /** Present when a compaction ran in this turn. */
  record?: CompactionRecord;
  usage?: UsageBucket;
}

/**
 * Builds the view for a turn and, when it is over the threshold, runs the compactor on it. A
 * failed or rejected compaction never ends the turn: the view stays as it was and the record
 * says why.
 */
export async function prepareHistory(
  compaction: ResolvedCompaction | undefined,
  messages: readonly AgentMessage[],
  context: CompactionContext,
): Promise<PreparedHistory> {
  const view = compactedView(messages);
  if (compaction === undefined) return { view };
  const charsBefore = serializedLength(view);
  if (charsBefore <= compaction.thresholdChars) return { view };

  const id = createId('cmp');
  const record = (fields: Omit<CompactionRecord, 'id' | 'cycle' | 'charsBefore'>): CompactionRecord => ({
    id,
    cycle: 0,
    charsBefore,
    ...fields,
  });

  let outcome: CompactionOutcome;
  try {
    outcome = await compaction.compactor(view, context);
  } catch (error) {
    return { view, record: record({ outcome: 'failed', detail: `Compaction failed. ${errorMessage(error)}` }) };
  }

  const detail = outcome.detail ?? '';
  if (outcome.edit === undefined || isEmptyEdit(outcome.edit)) {
    return { view, usage: outcome.usage, record: record({ outcome: 'unchanged', detail }) };
  }

  const compacted = applyCompactionEdit(view, outcome.edit, id);
  if (!sameOpenTurn(view, compacted)) {
    return {
      view,
      usage: outcome.usage,
      record: record({
        outcome: 'failed',
        detail: `Compaction was rejected because it changed the open turn. ${detail}`.trim(),
      }),
    };
  }

  return {
    view: compacted,
    usage: outcome.usage,
    record: record({
      outcome: 'applied',
      detail,
      charsAfter: serializedLength(compacted),
      edit: outcome.edit,
    }),
  };
}

/**
 * The history as the runtime sees it: every applied compaction recorded in the messages,
 * applied in order. Without any compaction records it is the messages themselves.
 */
export function compactedView(messages: readonly AgentMessage[]): AgentMessage[] {
  const records: CompactionRecord[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (part.type !== 'data-compaction') continue;
      const record = (part as { data: CompactionRecord }).data;
      if (record.outcome === 'applied' && record.edit !== undefined) records.push(record);
    }
  }
  let view = [...messages];
  for (const record of records) view = applyCompactionEdit(view, record.edit!, record.id);
  return view;
}

/**
 * Applies one edit. Tool edits rewrite or remove tool parts by call id, and the copy of each
 * output in the checkpoint metadata. A summary replaces every message before
 * `firstKeptMessageId` with one assistant message. Untouched messages are returned as the
 * same objects, and a message left without parts is removed.
 */
export function applyCompactionEdit(
  messages: readonly AgentMessage[],
  edit: CompactionEdit,
  id: string,
): AgentMessage[] {
  let view = [...messages];

  const tools = edit.tools;
  if (tools !== undefined && Object.keys(tools).length > 0) {
    view = view.flatMap(message => {
      const edited = editMessage(message, tools);
      return edited === undefined ? [] : [edited];
    });
  }

  const summary = edit.summary;
  if (summary !== undefined) {
    const index = view.findIndex(message => message.id === summary.firstKeptMessageId);
    if (index > 0) {
      const message: AgentMessage = {
        id: `${id}-summary`,
        role: 'assistant',
        parts: [{ type: 'text', text: summary.text }],
        metadata: { summary: { replacedMessages: index } },
      };
      view = [message, ...view.slice(index)];
    }
  }

  return view;
}

type Part = AgentMessage['parts'][number];

interface ToolPartLike {
  type: string;
  toolCallId: string;
  state: string;
}

function editMessage(
  message: AgentMessage,
  tools: Readonly<Record<string, ToolPartEdit>>,
): AgentMessage | undefined {
  let changed = false;
  const parts: Part[] = [];
  for (const part of message.parts) {
    const tool =
      part.type === 'dynamic-tool' || part.type.startsWith('tool-')
        ? (part as unknown as ToolPartLike)
        : undefined;
    const toolEdit = tool === undefined ? undefined : tools[tool.toolCallId];
    if (toolEdit === undefined) {
      parts.push(part);
      continue;
    }
    changed = true;
    if ('remove' in toolEdit) continue;
    parts.push({ ...part, ...toolEdit } as Part);
  }

  const checkpoint = editCheckpoint(message.metadata?.checkpoint, tools);
  if (!changed && checkpoint === message.metadata?.checkpoint) return message;
  if (parts.length === 0) return undefined;
  return {
    ...message,
    parts,
    ...(message.metadata === undefined ? {} : { metadata: { ...message.metadata, checkpoint } }),
  };
}

function editCheckpoint(
  checkpoint: StateCheckpoint | undefined,
  tools: Readonly<Record<string, ToolPartEdit>>,
): StateCheckpoint | undefined {
  if (checkpoint === undefined) return undefined;
  let changed = false;
  const observations = checkpoint.state.observations.map((observation): Observation => {
    const toolEdit = tools[observation.id];
    if (toolEdit === undefined || observation.kind !== 'tool-result' || observation.detail === undefined) {
      return observation;
    }
    if ('remove' in toolEdit) {
      changed = true;
      const { detail: _detail, ...rest } = observation;
      return rest;
    }
    if ('output' in toolEdit) {
      changed = true;
      return { ...observation, detail: toolEdit.output };
    }
    return observation;
  });
  return changed ? { ...checkpoint, state: { ...checkpoint.state, observations } } : checkpoint;
}

function isEmptyEdit(edit: CompactionEdit): boolean {
  return edit.summary === undefined && Object.keys(edit.tools ?? {}).length === 0;
}

/**
 * Whether two views reduce to the same state for the open turn. `stopReason` is left out: it
 * only reports how the previous turn ended, and a summary may remove that turn's message.
 */
function sameOpenTurn(before: readonly AgentMessage[], after: readonly AgentMessage[]): boolean {
  const comparable = (state: ExecutionState) => canonicalJson({ ...state, stopReason: undefined });
  return comparable(reduceState(before)) === comparable(reduceState(after));
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
