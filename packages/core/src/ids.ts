let counter = 0;

export function createId(prefix: string): string {
  counter += 1;
  const random = Math.random().toString(36).slice(2, 8);

  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${random}`;
}

export function stableHash(value: JsonValue): string {
  const json = canonicalJson(value);
  let hash = 5381;

  for (let i = 0; i < json.length; i += 1) {
    hash = ((hash << 5) + hash + json.charCodeAt(i)) | 0;
  }

  return (hash >>> 0).toString(36);
}

export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const object = jsonObject(value);

  if (object === undefined) return JSON.stringify(value) ?? 'undefined';
  const entries = Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

import { jsonObject, type JsonValue } from './json.ts';
