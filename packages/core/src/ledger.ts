import { Output, generateText, jsonSchema, type LanguageModel } from 'ai';
import { factType, type Fact, type FactRecord } from './facts.ts';
import { presentResult, type CallRecord } from './projection.ts';

/**
 * What the user wants, kept across turns: their goals, and every concrete value they asked
 * for, chose, or confirmed, each with the role it plays. Values that follow directly from
 * the request and the evidence, such as the day after a flight's date, are kept as derived
 * slots with their derivation, computed once and reused.
 */
export interface RequestLedger {
  goals: LedgerGoal[];
  slots: LedgerSlot[];
}

export interface LedgerGoal {
  id: string;
  description: string;
  status: 'open' | 'done' | 'dropped';
}

export interface LedgerSlot {
  /** Dotted name ending in the value's kind, such as `new_trip.date` or `selected_flight.flight_number`. */
  name: string;
  value: string;
  /** What the value is for, precisely: "date of the new outbound flight". */
  role: string;
  source: 'user' | 'derived';
  /** How a derived value was obtained. */
  derivation?: string;
  goal?: string;
}

export const emptyLedger: RequestLedger = { goals: [], slots: [] };

const ledgerSchema = jsonSchema<RequestLedger>({
  type: 'object',
  properties: {
    goals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['open', 'done', 'dropped'] },
        },
        required: ['id', 'description', 'status'],
      },
    },
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
          role: { type: 'string' },
          source: { type: 'string', enum: ['user', 'derived'] },
          derivation: { type: 'string' },
          goal: { type: 'string' },
        },
        required: ['name', 'value', 'role', 'source'],
      },
    },
  },
  required: ['goals', 'slots'],
});

export interface LedgerUpdate {
  previous: RequestLedger;
  /** The conversation so far, oldest first. Only the most recent messages are sent. */
  transcript: readonly { role: string; text: string }[];
  /** Tool calls made since the previous update. Only the most recent are sent. */
  newCalls: readonly CallRecord[];
  instructions?: string;
  /** Defaults to 20 seconds. A timed-out update keeps the previous ledger. */
  timeoutMs?: number;
}

// The previous ledger carries everything earlier, so each update sends a bounded window and
// costs the same however long the conversation grows.
const transcriptWindow = 12;
const callWindow = 10;

const ledgerSystem = [
  'You maintain a ledger of what the user wants from this conversation. A controller selects tool',
  'arguments from it, so every value must be exact and every role precise. The previous ledger already',
  'holds everything earlier; update it with the latest messages and tool calls.',
  'Goals: each distinct thing the user wants done or answered, recorded from the first message that',
  'expresses it, even before any concrete value is known. Mark a goal done only when the tool results',
  'show it done, and dropped when the user abandons it.',
  'Slots: each concrete value the user asked for, chose, or confirmed, as they stated it, such as a city,',
  'date, cabin, reservation, chosen flight, payment method, or count. Name it `<subject>.<kind>`, for',
  'example `new_trip.origin` or `selected_flight.flight_number`, and give a role that says exactly what',
  'it is for. When a tool result resolves what the user said into the form a tool needs, such as a city',
  'into its airport code or "the day after my flight" into a date, add a derived slot with that value and',
  'its derivation. Never record a value from a tool result as something the user asked for unless the',
  'user referred to it, and never guess values nobody gave. Keep earlier slots unless the user changed',
  'them; replace a slot the user changed.',
].join(' ');

/**
 * Updates the ledger for the latest user message with one structured model call over a
 * bounded window. If the call fails, times out, or returns nothing usable, the previous
 * ledger is kept.
 */
export async function updateLedger(
  model: LanguageModel,
  update: LedgerUpdate,
  abortSignal?: AbortSignal,
): Promise<RequestLedger> {
  const calls = update.newCalls
    .slice(-callWindow)
    .map(
      call =>
        `- [${call.ref}] ${call.tool}(${JSON.stringify(call.input)}) ` +
        (call.outcome === 'result'
          ? `returned ${JSON.stringify(presentResult(call.result, call.ref, 6_000))}`
          : `failed: ${String(call.result)}`),
    )
    .join('\n');
  let result;
  try {
    result = await generateText({
      model,
      system: ledgerSystem,
      prompt: [
        ...(update.instructions === undefined ? [] : [`Agent instructions:\n${update.instructions}`]),
        `Previous ledger:\n${JSON.stringify(update.previous)}`,
        `Latest messages:\n${update.transcript.slice(-transcriptWindow).map(entry => `${entry.role}: ${entry.text}`).join('\n')}`,
        `Tool calls since the previous update:\n${calls.length === 0 ? 'None.' : calls}`,
        'Return the updated ledger.',
      ].join('\n\n'),
      output: Output.object({ schema: ledgerSchema, name: 'ledger' }),
      abortSignal,
      timeout: { totalMs: update.timeoutMs ?? 20_000 },
    });
  } catch (error) {
    // A failed update must not break the turn: the previous ledger still describes the request.
    if (abortSignal?.aborted) throw error;
    return update.previous;
  }
  const ledger = result.output;
  if (ledger === undefined) return update.previous;
  return {
    goals: Array.isArray(ledger.goals) ? ledger.goals : [],
    slots: (Array.isArray(ledger.slots) ? ledger.slots : [])
      .filter(slot => typeof slot?.name === 'string' && slot.value !== undefined && String(slot.value).length > 0)
      .map(slot => ({ ...slot, value: String(slot.value) })),
  };
}

/** The ledger's slots as facts a controller can choose, typed by the kind their name ends in. */
export function ledgerFacts(ledger: RequestLedger): Fact[] {
  return ledger.slots.map(slot => ({
    type: factType(slot.name.split('.').at(-1) ?? slot.name),
    value: slot.value,
    label:
      `${slot.role} (${slot.source === 'user' ? 'stated by the user' : 'derived'}` +
      `${slot.derivation === undefined ? '' : `: ${slot.derivation}`}; slot ${slot.name})`,
    sources: ['ledger'],
  }));
}

/**
 * Records whose fields hold a slot's value are marked with that slot's role, so a choice
 * between similar records can follow what the user asked for.
 */
export function annotateRecords(records: readonly FactRecord[], ledger: RequestLedger): FactRecord[] {
  return records.map(record => {
    const matches = ledger.slots.filter(slot =>
      Object.entries(record.fields).some(
        ([field, value]) => String(value) === slot.value && factType(field) === factType(slot.name.split('.').at(-1) ?? ''),
      ),
    );
    if (matches.length === 0) return record;
    return { ...record, label: `${record.label} [matches ${matches.map(slot => `${slot.name}: ${slot.role}`).join('; ')}]` };
  });
}
