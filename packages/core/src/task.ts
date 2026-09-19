import type { AgentContext } from './tool.ts';

export interface TaskItem {
  id: string;
  text: string;
  /** Exact words from the user message that introduced this item. */
  quote: string;
  source: string;
}
export interface TaskGoal extends TaskItem {
  requiresWrite: boolean;
  status: 'pending' | 'completed' | 'withdrawn';
  evidence: string[];
}
export interface TaskContract {
  goals: TaskGoal[];
  constraints: TaskItem[];
  processedMessages: string[];
}
export interface TaskPatch {
  goals: { id: string; text: string; quote: string; requiresWrite: boolean }[];
  constraints: { id: string; text: string; quote: string }[];
  withdrawals: { id: string; quote: string }[];
}
export interface GoalEvidence { id: string; complete: boolean; evidence: string[] }
export interface TaskTracker {
  update(context: AgentContext): TaskPatch | PromiseLike<TaskPatch>;
  verify(context: AgentContext): readonly GoalEvidence[] | PromiseLike<readonly GoalEvidence[]>;
}
export function emptyTask(): TaskContract { return { goals: [], constraints: [], processedMessages: [] }; }

/** Updates are additive. Omitting an existing goal or constraint never removes it. */
export function applyTaskPatch(task: TaskContract, patch: TaskPatch, messageId: string, text: string): TaskContract {
  const next = structuredClone(task);
  const supported = (quote: string) => quote.trim().length > 0 && text.includes(quote);
  for (const goal of patch.goals) {
    if (!supported(goal.quote) || next.goals.some(g => g.id === goal.id)) continue;
    next.goals.push({ ...goal, source: messageId, status: 'pending', evidence: [] });
  }
  for (const constraint of patch.constraints) {
    if (!supported(constraint.quote) || next.constraints.some(c => c.id === constraint.id)) continue;
    next.constraints.push({ ...constraint, source: messageId });
  }
  // Withdrawal is an explicit event with current-user provenance, not absence in a summary.
  for (const removal of patch.withdrawals) {
    if (!supported(removal.quote)) continue;
    const goal = next.goals.find(g => g.id === removal.id);
    if (goal) goal.status = 'withdrawn';
    next.constraints = next.constraints.filter(c => c.id !== removal.id);
  }
  next.processedMessages.push(messageId);
  return next;
}
