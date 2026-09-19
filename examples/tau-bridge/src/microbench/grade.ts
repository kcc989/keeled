/** Grader-only comparison. Never passed to the resolver. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'undefined';
}
export function grade(inputs: unknown[], expected: unknown[], schemaValid: boolean, failed: boolean) {
  const actual = inputs.map(canonical), wanted = expected.map(canonical);
  return {
    matched: new Set(actual.filter(value => wanted.includes(value))).size,
    passed: !failed && schemaValid && actual.length === wanted.length && new Set(actual).size === actual.length && wanted.every(value => actual.includes(value)),
  };
}
