import { jsonSchema } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { callHistory } from './projection.ts';
import { isJsonValue, jsonObject, jsonString, type JsonObject, type JsonValue } from './json.ts';
import { stableHash } from './ids.ts';
import type { CallCandidate, CandidateProvider } from './tool.ts';
import type { Risk } from './types.ts';

export interface CandidateTool {
  name: string;
  description?: string;
  parameters: Parameters<typeof jsonSchema>[0];
  risk?: Risk;
}

/** Schema projection only: never infer joins, aliases, defaults, or ownership. */
export function schemaReadCandidates(
  tool: CandidateTool,
  catalog: readonly CandidateTool[],
): CandidateProvider | undefined {
  if (tool.risk !== 'read') return undefined;
  const parameters = tool.parameters;

  if (parameters === undefined) return undefined;

  if (!isJsonValue(parameters)) return undefined;
  const root = jsonObject(parameters);
  const properties = jsonObject(root?.['properties']);
  const requiredValue = root?.['required'];
  const required = Array.isArray(requiredValue) ? requiredValue.flatMap((name) => (isString(name) ? [name] : [])) : [];

  if (jsonString(root?.['type']) !== 'object' || properties === undefined || required.length === 0) return undefined;
  const fields = Object.keys(properties);
  const risks = new Map(catalog.map((entry) => [entry.name, entry.risk]));
  let schema: z.ZodType;

  try {
    // SAFETY: the JSON-value check above excludes non-schema runtime values and undefined.
    schema = z.fromJSONSchema(parameters as Exclude<Parameters<typeof jsonSchema>[0], undefined>);
  } catch {
    return undefined;
  }

  return async (context) => {
    const history = callHistory(context.conversation, context.state.observations);
    // Even a failed mutation may have changed the external system.
    const barrier = history.findLastIndex((call) => risks.get(call.tool) !== 'read');
    const fresh = history.slice(barrier + 1);
    const candidates = new Map<string, CallCandidate>();

    for (const call of fresh) {
      if (call.outcome !== 'result') continue;

      for (const record of records(call.result)) {
        context.abortSignal.throwIfAborted();

        if (!required.every((field) => Object.hasOwn(record, field))) continue;

        const input = Object.fromEntries(
          fields.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]]),
        );

        const checked = schema.safeParse(input);

        if (!checked.success || !isJsonValue(checked.data)) continue;
        const validInput = checked.data;

        if (
          fresh.some(
            (prior) =>
              prior.turn === 'current' &&
              prior.outcome === 'result' &&
              prior.tool === tool.name &&
              key(prior.input) === key(validInput),
          )
        )
          continue;
        const identity = key(validInput);
        const prior = candidates.get(identity);
        candidates.set(identity, {
          input: structuredClone(validInput),
          description: `Call ${tool.name} using matching fields from an observed record.`,
          sources: [...new Set([...(prior?.sources ?? []), call.ref])],
        });

        if (candidates.size >= 100) return [...candidates.values()];
      }
    }

    return [...candidates.values()];
  };
}

function isString(value: JsonValue): value is string {
  return typeof value === 'string';
}

function* records(value: JsonValue, depth = 0): Generator<JsonObject> {
  if (depth > 20) return;

  if (Array.isArray(value)) {
    for (const item of value) yield* records(item, depth + 1);
  } else {
    const object = jsonObject(value);

    if (object === undefined) return;
    yield object;

    for (const item of Object.values(object)) yield* records(item, depth + 1);
  }
}

function key(value: JsonValue): string {
  return stableHash(value);
}
