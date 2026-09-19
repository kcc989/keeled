import type { ModelMessage } from 'ai';
import type { AgentMessage, Blocker, ExecutionState, Observation } from './types.ts';
import type { AwaitingAction } from './controller.ts';
import { stableHash } from './ids.ts';
import type { Plan, StepStatus } from './plan.ts';

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
      .map(part => part.text)
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
      .map(part => part.text)
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
    .map(observation => {
      const scope = observation.tool === undefined ? '' : ` [${observation.tool}]`;
      const detail =
        observation.detail === undefined ? '' : ` ${json(presentResult(observation.detail, observation.id))}`;
      return `- (${observation.kind})${scope} ${observation.summary}${detail}`;
    })
    .join('\n');
}

export function digestPlan(
  plan: Plan | undefined,
  statuses: Readonly<Record<string, StepStatus>>,
): string {
  if (plan === undefined) return 'No active task.';
  const goals = plan.goals
    .map(goal => {
      const constraints = goal.constraints.length === 0 ? 'none' : goal.constraints.join('; ');
      const evidence = goal.evidence.length === 0 ? 'none' : goal.evidence.join(', ');
      return (
        `- ${goal.id} [${statuses[goal.id] ?? 'pending'}] ${goal.objective} ` +
        `(constraints: ${constraints}; achieved when: ${goal.completionCriteria}; ` +
        `evidence: ${evidence})`
      );
    })
    .join('\n');
  const constraints = plan.constraints.length === 0 ? 'None.' : plan.constraints.map(value => `- ${value}`).join('\n');
  const facts = plan.knownFacts.length === 0
    ? 'None.'
    : plan.knownFacts.map(fact => `- [${fact.source}] ${fact.statement}${fact.reference === undefined ? '' : ` (${fact.reference})`}`).join('\n');
  return `Objective: ${plan.objective}\nKind: ${plan.kind}\nRevision: ${plan.version}\nConstraints:\n${constraints}\nKnown facts:\n${facts}\nOrdered goals:\n${goals}`;
}

export const digestTaskState = digestPlan;

export function digestState(state: Readonly<ExecutionState>): Record<string, unknown> {
  return {
    cycle: state.cycle,
    stepsUsed: state.stepsUsed,
    toolCalls: state.toolCalls,
    planRevisions: state.planRevisions,
    stepStatuses: state.stepStatuses,
    blockers: state.blockers.slice(-4).map(blocker => blocker.reason),
  };
}

/** One completed tool call, with the input it was made with and what it returned. */
export interface CallRecord {
  /** The call's id, which is also the stable reference to its complete result. */
  ref: string;
  turn: 'earlier' | 'current';
  tool: string;
  input: unknown;
  outcome: 'result' | 'error';
  result: unknown;
}

interface ToolPartLike {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

/**
 * Every completed tool call in the conversation, each exactly once, in order. The current
 * turn's calls come from the reduced observations and are marked current; the persisted
 * parts supply earlier turns. A part whose call id the observations already hold belongs to
 * the message being written for this turn, so it is not projected again.
 */
export function callHistory(
  conversation: readonly AgentMessage[],
  observations: readonly Observation[],
): CallRecord[] {
  const current = new Set(
    observations
      .filter(observation => observation.kind === 'tool-result' || observation.kind === 'tool-error')
      .map(observation => observation.id),
  );
  const seen = new Set<string>();
  const history: CallRecord[] = [];

  for (const message of conversation) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts as ToolPartLike[]) {
      if (!part.type.startsWith('tool-') || part.toolCallId === undefined) continue;
      if (current.has(part.toolCallId) || seen.has(part.toolCallId)) continue;
      const tool = part.type.slice('tool-'.length);
      const base = { ref: part.toolCallId, turn: 'earlier' as const, tool, input: part.input };
      if (part.state === 'output-available') {
        seen.add(part.toolCallId);
        history.push({ ...base, outcome: 'result', result: part.output });
      } else if (part.state === 'output-error') {
        seen.add(part.toolCallId);
        history.push({ ...base, outcome: 'error', result: part.errorText });
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
      input: observation.input,
      outcome: failed ? 'error' : 'result',
      result: failed ? observation.summary : observation.detail,
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
    for (const part of message.parts as (ToolPartLike & { data?: Blocker })[]) {
      if (part.type === 'data-blocker' && part.data?.kind === 'needs_confirmation' && part.data.tool !== undefined) {
        const key = stableHash({ tool: part.data.tool, input: part.data.input });
        pending.set(key, {
          tool: part.data.tool,
          input: part.data.input,
          reason: part.data.reason,
          ...(part.data.stepId === undefined ? {} : { stepId: part.data.stepId }),
        });
      } else if (part.type.startsWith('tool-') && part.state === 'output-available') {
        pending.delete(stableHash({ tool: part.type.slice('tool-'.length), input: part.input }));
      }
    }
  }
  return [...pending.values()];
}

/** Default size, in characters of JSON, above which a result is presented in pages. */
export const defaultResultBudget = 16_000;

const longText = 2_000;

/**
 * A result sized for a prompt, never altered in meaning. A result within `maxChars` is
 * returned unchanged. A larger list is shown as a page of complete records in their original
 * order, with an explicit note of how many records were omitted and how to retrieve them by
 * reference; an object keeps every field and pages only its large list fields. Records are
 * never reduced to their field names, and only individual strings longer than a few thousand
 * characters are shortened, with the omission stated.
 */
export function presentResult(value: unknown, ref: string, maxChars = defaultResultBudget): unknown {
  if (json(value).length <= maxChars) return value;
  if (Array.isArray(value)) return pageOf(value, ref, undefined, maxChars);
  if (value !== null && typeof value === 'object') {
    const fieldBudget = Math.max(1_000, Math.floor(maxChars / 4));
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => {
        if (Array.isArray(inner) && json(inner).length > fieldBudget) return [key, pageOf(inner, ref, key, fieldBudget)];
        return [key, shortenStrings(inner)];
      }),
    );
  }
  return shortenStrings(value);
}

/** The first page of a list: as many complete records as fit, and what was left out. */
function pageOf(items: readonly unknown[], ref: string, path: string | undefined, maxChars: number) {
  const records: unknown[] = [];
  let size = 0;
  for (const item of items) {
    const record = shortenStrings(item);
    const length = json(record).length + 1;
    if (records.length > 0 && size + length > maxChars) break;
    records.push(record);
    size += length;
  }
  const omitted = items.length - records.length;
  const locator = path === undefined ? { ref } : { ref, path };
  return {
    total: items.length,
    records,
    ...(omitted === 0
      ? {}
      : {
          omitted: {
            count: omitted,
            retrieve: `evidence(${JSON.stringify({ ...locator, page: 2, pageSize: records.length })})`,
          },
        }),
  };
}

function shortenStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= longText
      ? value
      : `${value.slice(0, longText)}…[${value.length - longText} more characters omitted]`;
  }
  if (Array.isArray(value)) return value.map(shortenStrings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, shortenStrings(inner)]),
    );
  }
  return value;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
