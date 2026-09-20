/**
 * Runs the first N tasks from a τ³-bench domain through the standard bridge runner.
 *
 *   bun run tau3:first <domain> <count> [tau2 run options...]
 */
import { join } from 'node:path';

export function firstTaskArgs(args: readonly string[]): string[] {
  const [domain, countText, ...rest] = args;
  const count = Number(countText);

  if (
    domain === undefined ||
    domain.startsWith('-') ||
    countText === undefined ||
    !/^\d+$/.test(countText) ||
    !Number.isSafeInteger(count) ||
    count < 1
  ) {
    throw new Error('Usage: bun run tau3:first <domain> <positive task count> [tau2 run options...]');
  }

  if (rest.includes('--task-ids') || rest.includes('--num-tasks')) {
    throw new Error('Do not combine tau3:first with --task-ids or --num-tasks.');
  }

  const taskIds = Array.from({ length: count }, (_, index) => String(index));

  return [domain, '--task-ids', ...taskIds, ...rest];
}

if (import.meta.main) {
  try {
    const args = firstTaskArgs(Bun.argv.slice(2));

    const runner = Bun.spawn(['bun', 'run', join(import.meta.dir, 'run.ts'), ...args], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });

    process.exit(await runner.exited);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
