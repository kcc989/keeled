export interface RunnerOptions {
  controller: 'jev' | 'joint';
  tauArgs: string[];
}

/** Removes Keeled-only options before invoking the external benchmark CLI. */
export function runnerOptions(args: readonly string[]): RunnerOptions {
  const tauArgs: string[] = [];
  let controller: RunnerOptions['controller'] = 'jev';
  let seen = false;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;

    if (value !== '--keeled-controller') {
      tauArgs.push(value);
      continue;
    }

    if (seen) throw new Error('--keeled-controller may be supplied only once.');
    seen = true;
    const selected = args[++index];

    if (selected !== 'jev' && selected !== 'joint') {
      throw new Error('--keeled-controller must be "jev" or "joint".');
    }

    controller = selected;
  }

  return { controller, tauArgs };
}
