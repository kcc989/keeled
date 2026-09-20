import { expect, test } from 'bun:test';
import { grade } from '../src/microbench/grade.ts';
import { cases } from '../src/microbench/cases.ts';
import { z } from 'zod';

test('microbench grader ignores order but rejects duplicates, crossed pairs, and partial enumeration', () => {
  const expected = [
    { id: 'A', revision: 1 },
    { id: 'B', revision: 2 },
  ];

  expect(
    grade(
      [
        { revision: 2, id: 'B' },
        { revision: 1, id: 'A' },
      ],
      expected,
      true,
      false,
    ).passed,
  ).toBe(true);

  for (const actual of [
    [expected[0]],
    [expected[0], expected[0]],
    [
      { id: 'A', revision: 2 },
      { id: 'B', revision: 1 },
    ],
  ]) {
    expect(grade(actual, expected, true, false).passed).toBe(false);
  }
});

test('errors and invalid schemas cannot count as correct refusals', () => {
  expect(grade([], [], true, false).passed).toBe(true);
  expect(grade([], [], true, true).passed).toBe(false);
  expect(grade([{}], [], false, false).passed).toBe(false);
});

test('microbench expected inputs satisfy the supplied schemas including root references', () => {
  expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);

  for (const item of cases) {
    const schema = z.fromJSONSchema(item.tool.parameters);

    for (const input of [...item.expected, ...(item.candidateExpected ?? [])])
      expect(schema.safeParse(input).success).toBe(true);
  }
});

test('microbench spans at least 50 unique cases, many domains, and three difficulty levels', () => {
  expect(cases.length).toBeGreaterThanOrEqual(50);
  expect(new Set(cases.map((c) => c.domain)).size).toBeGreaterThanOrEqual(10);

  for (const difficulty of ['simple', 'intermediate', 'complex']) {
    expect(cases.filter((c) => c.difficulty === difficulty).length).toBeGreaterThanOrEqual(10);
  }

  expect(cases.filter((c) => c.expected.length === 0).length).toBeGreaterThanOrEqual(10);

  for (const item of cases) {
    expect(item.steps).toBe(Math.max(1, item.expected.length));
    expect(item.problem.length).toBeGreaterThan(10);
  }
});
