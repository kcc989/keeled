import { describe, expect, test } from 'bun:test';
import { runnerOptions } from '../src/runner-options.ts';

describe('Keeled runner options', () => {
  test('defaults to Jev and leaves Tau options unchanged', () => {
    expect(runnerOptions(['--seed', '300'])).toEqual({ controller: 'jev', tauArgs: ['--seed', '300'] });
  });

  test('selects joint mode without forwarding the private option', () => {
    expect(runnerOptions(['--task-timeout', '300', '--keeled-controller', 'joint'])).toEqual({
      controller: 'joint',
      tauArgs: ['--task-timeout', '300'],
    });
  });

  test('rejects an unknown controller', () => {
    expect(() => runnerOptions(['--keeled-controller', 'other'])).toThrow('must be "jev" or "joint"');
  });
});
