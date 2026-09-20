import { emptyTask } from './task.ts';
import type {
  AgentMessage,
  BlockerRecord,
  DecisionRecord,
  ExecutionState,
  Observation,
  TransitionRecord,
} from './types.ts';
import type { JsonValue } from './json.ts';

export const reducerVersion = 4;

export function emptyState(): ExecutionState {
  return {
    reducerVersion,
    task: emptyTask(),
    uncertainOperations: [],
    inspections: [],
    cycle: 0,
    stepsUsed: 0,
    observations: [],
    blockers: [],
    toolCalls: 0,
  };
}

/**
 * Pure, versioned reduction of persisted message data into execution state.
 *
 * Terminal transitions reset turn-local execution state. Tool history and pending
 * confirmations remain in the messages. Legacy planning metadata is ignored.
 */
export function reduceState(messages: readonly AgentMessage[]): ExecutionState {
  let state = emptyState();
  const context: ReduceContext = {};

  for (const message of messages) {
    if (message.role !== 'assistant') continue;

    for (const part of message.parts) {
      applyPart(state, part, context);

      if (part.type === 'data-transition') {
        // SAFETY: the adjacent validation or framework contract establishes the asserted type.
        const record = (part as { data: TransitionRecord }).data;

        if (record.stopReason !== undefined) {
          state = nextTurnState(state);
          delete context.tool;
        }
      }
    }
  }

  return state;
}

function nextTurnState(completed: ExecutionState): ExecutionState {
  return {
    ...emptyState(),
    task: completed.task,
    uncertainOperations: completed.uncertainOperations,
    inspections: completed.inspections,
    stopReason: completed.stopReason,
  };
}

/** The decision currently in effect, which attributes the tool parts that follow it. */
interface ReduceContext {
  tool?: string;
}

function applyPart(state: ExecutionState, part: AgentMessage['parts'][number], context: ReduceContext): void {
  const type = part.type;

  if (part.type === 'data-inspection') {
    state.inspections.push(structuredClone(part.data));

    return;
  }

  if (part.type === 'data-operation') {
    const index = state.uncertainOperations.findIndex((operation) => operation.id === part.data.id);

    if (index === -1) state.uncertainOperations.push(structuredClone(part.data));
    else state.uncertainOperations[index] = structuredClone(part.data);

    return;
  }

  if (part.type === 'data-task') {
    state.task = structuredClone(part.data);

    return;
  }

  if (type === 'data-decision') {
    // SAFETY: the adjacent validation or framework contract establishes the asserted type.
    const record = (part as { data: DecisionRecord }).data;
    state.cycle = Math.max(state.cycle, record.cycle);
    state.stepsUsed += 1;
    delete state.stopReason;
    context.tool = record.action.type === 'respond' ? undefined : record.action.tool;

    return;
  }

  if (type === 'data-blocker') {
    // SAFETY: the adjacent validation or framework contract establishes the asserted type.
    const record = (part as { data: BlockerRecord }).data;
    state.blockers.push(record);
    state.observations.push({
      id: record.id,
      cycle: record.cycle,
      kind: 'blocked',
      tool: record.tool,
      summary: record.reason,
    });

    return;
  }

  if (type === 'data-transition') {
    // SAFETY: the adjacent validation or framework contract establishes the asserted type.
    const record = (part as { data: TransitionRecord }).data;

    if (record.kind === 'controller-error') state.stepsUsed += 1;

    if (record.stopReason !== undefined) state.stopReason = record.stopReason;

    return;
  }

  if (type.startsWith('tool-') || type === 'dynamic-tool') {
    // SAFETY: the adjacent validation or framework contract establishes the asserted type.
    applyToolPart(state, part as ToolPartLike, context);
  }
}

interface ToolPartLike {
  type: string;
  toolCallId: string;
  toolName?: string;
  state: string;
  input?: JsonValue;
  output?: JsonValue;
  errorText?: string;
}

function applyToolPart(state: ExecutionState, part: ToolPartLike, context: ReduceContext): void {
  const toolName =
    part.toolName ?? (part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : context.tool) ?? 'unknown';

  if (part.state === 'output-available') {
    state.toolCalls += 1;
    state.observations.push({
      id: part.toolCallId,
      cycle: state.cycle,
      kind: 'tool-result',
      tool: toolName,
      summary: `${toolName} returned a result.`,
      input: part.input ?? null,
      detail: part.output ?? null,
    });

    return;
  }

  if (part.state === 'output-error') {
    state.toolCalls += 1;

    const observation: Observation = {
      id: part.toolCallId,
      cycle: state.cycle,
      kind: 'tool-error',
      tool: toolName,
      summary: part.errorText ?? `${toolName} failed.`,
      input: part.input ?? null,
      detail: part.input ?? null,
    };

    state.observations.push(observation);
  }
}
