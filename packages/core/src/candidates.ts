import { jsonSchema } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { callHistory } from './projection.ts';
import type { CallCandidate, CandidateProvider } from './tool.ts';
import type { Risk } from './types.ts';

export interface CandidateTool {
  name: string;
  description?: string;
  parameters: Parameters<typeof jsonSchema>[0];
  risk?: Risk;
}

/** Schema projection only: never infer joins, aliases, defaults, or ownership. */
export function schemaReadCandidates(tool: CandidateTool, catalog: readonly CandidateTool[]): CandidateProvider | undefined {
  if (tool.risk !== 'read') return undefined;
  const root = tool.parameters as { type?: string; properties?: Record<string, unknown>; required?: string[] };
  if (root.type !== 'object' || !root.properties || !root.required?.length) return undefined;
  const required = root.required;
  const fields = Object.keys(root.properties);
  const risks = new Map(catalog.map(entry => [entry.name, entry.risk]));
  let schema: z.ZodType;
  try { schema = z.fromJSONSchema(tool.parameters); } catch { return undefined; }
  return async context => {
    const history = callHistory(context.conversation, context.state.observations);
    // Even a failed mutation may have changed the external system.
    const barrier = history.findLastIndex(call => risks.get(call.tool) !== 'read');
    const fresh = history.slice(barrier + 1);
    const candidates = new Map<string, CallCandidate>();
    for (const call of fresh) {
      if (call.outcome !== 'result') continue;
      for (const record of records(call.result)) {
        context.abortSignal.throwIfAborted();
        if (!required.every(field => Object.hasOwn(record, field))) continue;
        const input = Object.fromEntries(fields.filter(field => Object.hasOwn(record, field)).map(field => [field, record[field]]));
        const checked = schema.safeParse(input);
        if (!checked.success) continue;
        if (fresh.some(prior => prior.turn === 'current' && prior.outcome === 'result' && prior.tool === tool.name && key(prior.input) === key(checked.data))) continue;
        const identity = key(checked.data);
        const prior = candidates.get(identity);
        candidates.set(identity, {
          input: structuredClone(checked.data), description: `Call ${tool.name} using matching fields from an observed record.`,
          sources: [...new Set([...(prior?.sources ?? []), call.ref])],
        });
        if (candidates.size >= 100) return [...candidates.values()];
      }
    }
    return [...candidates.values()];
  };
}

function* records(value: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 20 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) yield* records(item, depth + 1);
  } else {
    yield value as Record<string, unknown>;
    for (const item of Object.values(value)) yield* records(item, depth + 1);
  }
}
function key(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(key).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + key(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'undefined';
}
