import { callHistory, type AgentContext, type CallCandidate, type CandidateProvider } from '@keeled/core';
import type { ToolSpec } from './tools.ts';

/** Explicit airline mappings: schemas alone do not establish identity or relationships. */
export function readCandidates(spec: ToolSpec, catalog: readonly ToolSpec[]): CandidateProvider | undefined {
  if (spec.risk !== 'read' || !['get_user_details', 'get_reservation_details', 'get_flight_status'].includes(spec.name)) {
    return undefined;
  }
  const risks = new Map(catalog.map(tool => [tool.name, tool.risk]));
  return context => airlineReadCandidates(spec.name, context, risks);
}

export function airlineReadCandidates(
  tool: string,
  context: AgentContext,
  risks: ReadonlyMap<string, unknown>,
): CallCandidate[] {
  const history = callHistory(context.conversation, context.state.observations);
  // A mutation invalidates the old snapshot. Unknown tools are conservative barriers too.
  const barrier = history.findLastIndex(call => call.outcome === 'result' && risks.get(call.tool) !== 'read');
  const fresh = history.slice(barrier + 1);
  const candidates = new Map<string, CallCandidate>();
  const add = (input: Record<string, string>, description: string, source: string) => {
    // Suppress successful repeats within this turn. A new user turn can request a refresh.
    if (fresh.some(call => call.turn === 'current' && call.outcome === 'result' && call.tool === tool &&
      sameInput(call.input, input))) return;
    const key = JSON.stringify(input);
    const prior = candidates.get(key);
    candidates.set(key, { input, description, sources: [...new Set([...(prior?.sources ?? []), source])] });
  };
  for (const call of fresh) {
    if (call.outcome !== 'result') continue;
    const result = record(call.result);
    if (tool === 'get_reservation_details' && call.tool === 'get_user_details' && result !== undefined) {
      if (Array.isArray(result.reservations)) {
        for (const id of result.reservations) {
          if (typeof id === 'string') add({ reservation_id: id }, `Inspect a reservation belonging to user ${String(result.user_id)}.`, call.ref);
        }
      }
    }
    if (tool === 'get_user_details' && call.tool === 'get_reservation_details' && typeof result?.user_id === 'string') {
      add({ user_id: result.user_id }, `Inspect the owner of reservation ${String(result.reservation_id)}.`, call.ref);
    }
    if (tool !== 'get_flight_status') continue;
    if (call.tool === 'get_reservation_details' && Array.isArray(result?.flights)) {
      for (const flight of result.flights) {
        const row = record(flight);
        if (typeof row?.flight_number === 'string' && typeof row.date === 'string') {
          add({ flight_number: row.flight_number, date: row.date }, `Check a flight in reservation ${String(result?.reservation_id)}.`, call.ref);
        }
      }
    }
    // Direct results can omit dates; connecting legs carry their own departure dates.
    if (call.tool === 'search_direct_flight' || call.tool === 'search_onestop_flight') {
      const date = record(call.input)?.date;
      if (typeof date !== 'string' || !Array.isArray(call.result)) continue;
      for (const itinerary of call.result) {
        for (const flight of Array.isArray(itinerary) ? itinerary : [itinerary]) {
          const row = record(flight);
          if (typeof row?.flight_number === 'string') {
            const departureDate = typeof row.date === 'string' ? row.date : date;
            add({ flight_number: row.flight_number, date: departureDate }, `Check ${String(row.origin)} to ${String(row.destination)} from this search.`, call.ref);
          }
        }
      }
    }
  }
  return [...candidates.values()];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sameInput(value: unknown, expected: Record<string, string>): boolean {
  const input = record(value);
  return input !== undefined && Object.keys(input).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => input[key] === value);
}
