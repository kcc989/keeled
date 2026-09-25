import { describe, expect, test } from 'bun:test';
import { runnerOptions } from '../src/runner-options.ts';

describe('Keeled runner options', () => {
  test('defaults to Jev and leaves Tau options unchanged', () => {
    expect(runnerOptions(['--seed', '300'])).toEqual({
      controller: 'jev',
      toolGuide: false,
      tauArgs: ['--seed', '300'],
    });
  });

  test('selects joint mode without forwarding the private option', () => {
    expect(runnerOptions(['--task-timeout', '300', '--keeled-controller', 'joint'])).toEqual({
      controller: 'joint',
      toolGuide: false,
      tauArgs: ['--task-timeout', '300'],
    });
  });

  test('enables the tool guide without forwarding the private option', () => {
    expect(runnerOptions(['--keeled-tool-guide', '--seed', '300'])).toEqual({
      controller: 'jev',
      toolGuide: true,
      tauArgs: ['--seed', '300'],
    });
  });

  test('rejects the tool guide with the joint controller', () => {
    expect(() => runnerOptions(['--keeled-tool-guide', '--keeled-controller', 'joint'])).toThrow(
      'applies only to the Jev controller',
    );
  });

  test('rejects an unknown controller', () => {
    expect(() => runnerOptions(['--keeled-controller', 'other'])).toThrow('must be "jev" or "joint"');
  });
});
