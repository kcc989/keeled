import { z } from 'zod';

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[] | undefined;

export interface JsonObject {
  [key: string]: JsonValue;
}

const jsonValueSchema = z.json();

const finiteNumberSchema = z.number().finite();

const stringSchema = z.string();

/** Validate an untrusted transport value before it enters persisted agent state. */
export function isJsonValue(value: unknown): value is JsonValue {
  return value === undefined || jsonValueSchema.safeParse(value).success;
}

export function jsonObject(value: JsonValue): JsonObject | undefined {
  if (value === null || value === undefined || Array.isArray(value)) return undefined;

  if (Object.prototype.toString.call(value) !== '[object Object]') return undefined;

  // SAFETY: the prototype tag and array/null checks establish a string-keyed plain object.
  return value as JsonObject;
}

export function jsonNumber(value: JsonValue): number | undefined {
  const result = finiteNumberSchema.safeParse(value);

  return result.success ? result.data : undefined;
}

export function jsonString(value: JsonValue): string | undefined {
  const result = stringSchema.safeParse(value);

  return result.success ? result.data : undefined;
}
