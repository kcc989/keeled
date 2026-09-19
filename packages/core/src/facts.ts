import type { CallRecord } from './projection.ts';

/**
 * A value the conversation has already established, which a controller can select as a
 * tool argument instead of a model generating it. Facts are extracted mechanically: no
 * model is involved, so building the index costs nothing and cannot invent values.
 */
export interface Fact {
  /** The kind of value, from the key it appeared under: `documents[]` → `document`. */
  type: string;
  value: string | number;
  /** What distinguishes this value, from the other fields of the record it came from. */
  label: string;
  /** Call references, or `user` for values the user stated, where the value appeared. */
  sources: string[];
}

export interface UserStatement {
  text: string;
}

const maxLabel = 160;

/**
 * Indexes every scalar value in the tool results, typed by its key, and every identifier,
 * date, or code the user wrote. A value seen in several places becomes one fact with every
 * source and the most specific label.
 */
export function factIndex(history: readonly CallRecord[], statements: readonly UserStatement[] = []): Fact[] {
  const facts = new Map<string, Fact>();
  const specificity = new Map<string, number>();
  // A label from the record a value belongs to says more than one from a list that merely
  // names it; within a kind, the fuller label wins.
  const add = (type: string, value: string | number, label: string, source: string, fromRecord: boolean) => {
    const key = JSON.stringify([type, value]);
    const rank = (fromRecord ? 1_000_000 : 0) + label.length;
    const existing = facts.get(key);
    if (existing === undefined) {
      facts.set(key, { type, value, label, sources: [source] });
      specificity.set(key, rank);
      return;
    }
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (rank > specificity.get(key)!) {
      existing.label = label;
      specificity.set(key, rank);
    }
  };

  for (const call of history) {
    if (call.outcome !== 'result') continue;
    walk(call.result, [], (key, value, record, ancestors) => {
      // An `id` is named by the collection it belongs to; a map keyed by ids is skipped over.
      const collection = ancestors.findLast(ancestor => ancestor !== String(value));
      const type = factType(key === 'id' && collection !== undefined ? collection : key);
      if (type.length === 0) return;
      const described = record === undefined ? '' : describe(record, key);
      const label = described || `one of ${ancestors.at(-1) ?? key} returned by ${call.tool}`;
      add(type, value, label, call.ref, described.length > 0);
    });
  }

  for (const statement of statements) {
    for (const token of mentions(statement.text)) add('mentioned', token, 'stated by the user', 'user', false);
  }

  return [...facts.values()];
}

/**
 * The facts that could fill a parameter: those whose type matches its name, most specific
 * first, then values the user mentioned, which carry no type of their own.
 */
export function candidatesFor(parameter: string, facts: readonly Fact[]): Fact[] {
  const wanted = factType(parameter);
  const head = wanted.split('_')[0];
  const exact = facts.filter(fact => fact.type === wanted);
  const related = facts.filter(fact => fact.type !== wanted && fact.type !== 'mentioned' && fact.type.split('_')[0] === head);
  const typed = [...exact, ...related];
  const mentioned = facts.filter(fact => fact.type === 'mentioned' && !typed.some(other => other.value === fact.value));
  return [...typed, ...mentioned];
}

/** `document_id`, `documents`, and `document` are one kind of value. */
export function factType(key: string): string {
  const tokens = key
    .toLowerCase()
    .replace(/\[\d*\]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 0);
  while (tokens.length > 1 && (tokens.at(-1) === 'id' || tokens.at(-1) === 'ids')) tokens.pop();
  const last = tokens.at(-1);
  if (last !== undefined && last.length > 3) {
    if (last.endsWith('ies')) tokens[tokens.length - 1] = `${last.slice(0, -3)}y`;
    else if (last.endsWith('s') && !/(ss|us|is)$/.test(last)) tokens[tokens.length - 1] = last.slice(0, -1);
  }
  return tokens.join('_');
}

type Visit = (
  key: string,
  value: string | number,
  record: Record<string, unknown> | undefined,
  ancestors: readonly string[],
) => void;

/**
 * Visits scalar leaves with the key they sit under, the record that holds them, and the
 * keys of the containers above them. Scalars in a list take the list's key.
 */
function walk(value: unknown, ancestors: readonly string[], visit: Visit): void {
  if (Array.isArray(value)) {
    const key = ancestors.at(-1);
    for (const item of value) {
      if (isScalar(item)) {
        if (key !== undefined) visit(key, item, undefined, ancestors);
      } else walk(item, ancestors, visit);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const [field, inner] of Object.entries(record)) {
      if (isScalar(inner)) visit(field, inner, record, ancestors);
      else walk(inner, [...ancestors, field], visit);
    }
  }
}

function isScalar(value: unknown): value is string | number {
  return (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value));
}

function describe(record: Record<string, unknown>, except: string): string {
  const parts: string[] = [];
  for (const [field, inner] of Object.entries(record)) {
    if (field === except || !isScalar(inner)) continue;
    parts.push(`${field}=${inner}`);
  }
  const text = parts.join(', ');
  return text.length <= maxLabel ? text : `${text.slice(0, maxLabel)}…`;
}

// Identifiers, codes, dates, and short codes a user might state. Plain words are left out.
const mentionPatterns = [
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi,
  /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,10}\b/g,
  /\b[A-Z]{3}\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
];

function mentions(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of mentionPatterns) {
    for (const match of text.matchAll(pattern)) found.add(match[0]);
  }
  return [...found];
}
