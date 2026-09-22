import { jsonObject, jsonString, type JsonValue } from './json.ts';
import type { CatalogSource, Fact, SourceSpan } from './context.ts';

/** Reducer-only update vocabulary. There are no executable reducers in model outputs. */
export type KnowledgeUpdate =
  | { type: 'derive'; fact: Fact; dependencies: Array<{ id: string; revision: number }> }
  | { type: 'lifecycle'; id: string; revision: number; status: 'superseded' | 'retracted'; support: SourceSpan };

export function sourceValue(catalog: readonly CatalogSource[], span: SourceSpan): JsonValue {
  const source = catalog.find((entry) => entry.id === span.sourceId && entry.version === span.sourceVersion);

  if (source === undefined) throw new Error('Missing source version.');
  const location = span.location;

  if ('start' in location) {
    const text = jsonString(source.content);

    if (
      text === undefined ||
      !Number.isInteger(location.start) ||
      !Number.isInteger(location.end) ||
      location.start < 0 ||
      location.end <= location.start ||
      location.end > text.length
    )
      throw new Error('Invalid source offsets.');

    return text.slice(location.start, location.end);
  }

  if (location.jsonPointer === '') return source.content;

  if (!location.jsonPointer.startsWith('/')) throw new Error('Invalid JSON pointer.');
  let value = source.content;

  for (const token of location.jsonPointer.slice(1).split('/')) {
    if (/~(?![01])/u.test(token)) throw new Error('Invalid JSON pointer escape.');
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    const container = Array.isArray(value) ? value : jsonObject(value);

    if (container === undefined || !Object.hasOwn(container, key)) throw new Error('Missing source field.');
    value = Array.isArray(container) ? container[Number(key)] : container[key];
  }

  return value;
}

/** Validates an exact copied projection. Free-form extracted claims are not accepted. */
export function applyKnowledgeUpdate(catalog: CatalogSource[], update: KnowledgeUpdate): boolean {
  const facts = catalog.flatMap((source) => source.facts);

  if (update.type === 'derive') {
    const fact = update.fact;

    if (
      fact.origin !== 'derived' ||
      fact.status !== 'active' ||
      fact.revision !== 1 ||
      fact.sources.length === 0 ||
      update.dependencies.length === 0 ||
      facts.some((entry) => entry.id === fact.id)
    )
      return false;

    if (
      update.dependencies.some(
        (dependency) =>
          !facts.some(
            (entry) =>
              entry.id === dependency.id && entry.revision === dependency.revision && entry.status === 'active',
          ),
      )
    )
      return false;
    const dependencyFacts = update.dependencies.map((dependency) => facts.find((entry) => entry.id === dependency.id)!);

    const covered = (span: SourceSpan) =>
      dependencyFacts.some((dependency) =>
        dependency.sources.some((basis) => {
          if (basis.sourceId !== span.sourceId || basis.sourceVersion !== span.sourceVersion) return false;

          if ('start' in basis.location && 'start' in span.location)
            return basis.location.start <= span.location.start && basis.location.end >= span.location.end;

          if ('jsonPointer' in basis.location && 'jsonPointer' in span.location)
            return (
              basis.location.jsonPointer === span.location.jsonPointer ||
              span.location.jsonPointer.startsWith(`${basis.location.jsonPointer}/`)
            );

          return false;
        }),
      );

    if (fact.sources.some((span) => !covered(span))) return false;

    if (fact.kind === 'passage' && jsonString(fact.value) === undefined) return false;
    let copied: JsonValue[];

    try {
      copied = fact.sources.map((span) => sourceValue(catalog, span));
    } catch {
      return false;
    }

    // Derived projections copy an exact value or an ordered group of exact source values.
    if (JSON.stringify(fact.value) !== JSON.stringify(copied.length === 1 ? copied[0] : copied)) return false;

    const owner = catalog.find(
      (source) => source.id === fact.sources[0]!.sourceId && source.version === fact.sources[0]!.sourceVersion,
    );

    if (owner === undefined || owner.authority === 'proposal' || owner.status === 'superseded') return false;
    owner.facts.push({ ...structuredClone(fact), dependencies: structuredClone(update.dependencies) });

    return true;
  }

  const target = facts.find(
    (fact) => fact.id === update.id && fact.revision === update.revision && fact.status === 'active',
  );

  const support = catalog.find(
    (source) => source.id === update.support.sourceId && source.version === update.support.sourceVersion,
  );

  const original = catalog.find(
    (source) => source.id === target?.sources[0]?.sourceId && source.version === target?.sources[0]?.sourceVersion,
  );

  // User corrections cannot rewrite tool observations or policies. Tool text grants no authority.
  if (
    !target ||
    !support ||
    !original ||
    !['user', 'instructions'].includes(support.authority) ||
    support.authority !== original.authority ||
    support.order <= original.order
  )
    return false;

  try {
    if (!jsonString(sourceValue(catalog, update.support))?.trim()) return false;
  } catch {
    return false;
  }

  target.status = update.status;
  target.revision += 1;
  target.correction = structuredClone(update.support);

  invalidateDerivedFacts(catalog);

  return true;
}

/** Invalidate dependent projections transitively after any accepted catalog update. */
export function invalidateDerivedFacts(catalog: CatalogSource[]): void {
  const facts = catalog.flatMap((source) => source.facts);
  let changed = true;

  while (changed) {
    changed = false;

    for (const fact of facts) {
      if (fact.origin !== 'derived' || fact.status !== 'active' || fact.dependencies === undefined) continue;

      if (
        fact.dependencies.some(
          (dependency) =>
            !facts.some(
              (source) =>
                source.id === dependency.id && source.revision === dependency.revision && source.status === 'active',
            ),
        )
      ) {
        fact.status = 'superseded';
        fact.revision += 1;
        changed = true;
      }
    }
  }
}
