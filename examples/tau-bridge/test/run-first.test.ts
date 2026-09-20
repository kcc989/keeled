import { describe, expect, test } from 'bun:test';
import { firstTaskArgs } from '../src/run-first';

describe('firstTaskArgs', () => {
  test('selects zero-based task IDs and forwards other options', () => {
    expect(firstTaskArgs(['airline', '3', '--max-concurrency', '1'])).toEqual([
      'airline',
      '--task-ids',
      '0',
      '1',
      '2',
      '--max-concurrency',
      '1',
    ]);
  });

  test.each([[[]], [['airline']], [['airline', '0']], [['airline', '-1']], [['airline', '1.5']]])(
    'rejects invalid input: %p',
    (args: string[]) => {
      expect(() => firstTaskArgs(args)).toThrow('Usage:');
    },
  );

  test.each([[['airline', '3', '--task-ids', '4']], [['airline', '3', '--num-tasks', '2']]])(
    'rejects another task selector: %p',
    (args: string[]) => {
      expect(() => firstTaskArgs(args)).toThrow('Do not combine');
    },
  );
});
