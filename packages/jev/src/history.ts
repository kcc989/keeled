import { callHistory as coreCallHistory, type Blocker, type CallRecord, type ControllerContext } from '@keeled/core';

export type { CallRecord };

/** Every completed tool call in the conversation, with its input and full result. */
export function callHistory(context: ControllerContext): CallRecord[] {
  return coreCallHistory(context.conversation, context.observations);
}

/**
 * A factual note on how the agent has already used a tool this turn, appended to that
 * tool's option so that repetition bears on the choice. It reports what happened and what
 * came back; whether another call is worthwhile is left to the controller, since neither a
 * returned result nor a repeated one proves what a further call would do.
 */
export function repetitionNote(tool: string, history: readonly CallRecord[]): string {
  const calls = history.filter(call => call.turn === 'current' && call.tool === tool);
  const last = calls.at(-1);
  if (last === undefined) return '';

  const facts: string[] = [];
  if (calls.length > 1) {
    const sameInput = calls.filter(call => same(call.input, last.input)).length;
    facts.push(`${sameInput} of them with the latest input`);
    const previous = calls.at(-2)!;
    if (previous.outcome === last.outcome && same(previous.result, last.result)) {
      facts.push('the last two returned identical results');
    }
  }
  const times = calls.length === 1 ? 'once' : `${calls.length} times`;
  const detail = facts.length === 0 ? '' : ` (${facts.join('; ')})`;
  const latest =
    last.outcome === 'result' ? `Latest result: ${excerpt(last.result)}` : `Latest call failed: ${excerpt(last.result)}`;
  return ` Called ${times} this turn${detail}. ${latest}`;
}

function excerpt(value: unknown, max = 160): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** How the tool was last blocked this turn and what would resolve it, so the choice reflects it. */
export function blockerNote(tool: string, blockers: readonly Blocker[]): string {
  const own = blockers.filter(blocker => blocker.tool === tool);
  const last = own.at(-1);
  if (last === undefined) return '';
  const times = own.length === 1 ? 'Blocked this turn' : `Blocked ${own.length} times this turn`;
  return ` ${times} (${last.kind}): ${last.reason} To resolve: ${last.resolution}`;
}

/**
 * Notes for the respond options that follow from the turn's blockers: a pending
 * confirmation makes asking the user the way forward, and a refused completion is reported
 * where the controller would propose it again.
 */
export function respondNotes(blockers: readonly Blocker[]): { needsInput: string; completed: string } {
  const awaiting = blockers.filter(blocker => blocker.kind === 'needs_confirmation');
  const refused = blockers.filter(blocker => blocker.kind === 'completion_refused');
  const pending = awaiting.map(blocker => `${blocker.tool}(${JSON.stringify(blocker.input)})`);
  return {
    needsInput:
      pending.length === 0
        ? ''
        : ` An action awaits the user's explicit confirmation: ${pending.join('; ')}. Asking the user to confirm it resolves this.`,
    completed:
      refused.length === 0
        ? ''
        : ` Completion was refused ${refused.length === 1 ? 'once' : `${refused.length} times`} this turn: ${refused.at(-1)!.reason}`,
  };
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  ) ?? 'undefined';
}
