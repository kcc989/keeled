/**
 * Starts the bridge, runs one τ³-bench domain against it, and stops the bridge.
 *
 *   bun run tau3 <domain> [tau2 run options...]
 *
 * TAU2_DIR points at the τ³-bench checkout (default ~/projects/tau2-bench).
 * TAU2_USER_LLM sets the user simulator (default openrouter/openai/gpt-4.1).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

const [domain, ...rest] = Bun.argv.slice(2);
if (domain === undefined || domain.startsWith('-')) {
  console.error(`Usage: bun run tau3 <domain> [tau2 run options...]`);
  process.exit(1);
}

const tau2Dir = process.env['TAU2_DIR'] ?? join(homedir(), 'projects', 'tau2-bench');
const tau2 = join(tau2Dir, '.venv', 'bin', 'tau2');
if (!(await Bun.file(tau2).exists())) {
  console.error(`No tau2 CLI at ${tau2}. Set TAU2_DIR to the τ³-bench checkout.`);
  process.exit(1);
}

const port = process.env['KEELED_BRIDGE_PORT'] ?? '8787';
const bridgeUrl = `http://localhost:${port}`;
// Another run's bridge would pass the health check and then stop mid-run when that run ends.
if (await fetch(`${bridgeUrl}/health`).then(r => r.ok, () => false)) {
  console.error(`A bridge is already running on port ${port}. Wait for that run, or set KEELED_BRIDGE_PORT.`);
  process.exit(1);
}
const bridge = Bun.spawn(['bun', 'run', join(import.meta.dir, 'server.ts')], {
  env: { ...process.env, KEELED_BRIDGE_PORT: port },
  stdout: 'inherit',
  stderr: 'inherit',
});

const code = await (async () => {
  if (!(await healthy(bridgeUrl, bridge))) return 1;

  const args = ['run', '--domain', domain, ...defaults(rest), ...rest];
  console.log(`$ tau2 ${args.join(' ')}`);
  const run = Bun.spawn([tau2, ...args], {
    cwd: tau2Dir,
    env: { ...benchmarkEnv(), KEELED_BRIDGE_URL: bridgeUrl },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return await run.exited;
})();

bridge.kill();
process.exit(code);

function defaults(given: string[]): string[] {
  const set = (flag: string, value: string) => (given.includes(flag) ? [] : [flag, value]);
  return [
    ...set('--agent', 'keeled'),
    ...set('--agent-llm', 'keeled'),
    ...set('--user-llm', process.env['TAU2_USER_LLM'] ?? 'openrouter/openai/gpt-4.1'),
    ...set('--num-trials', '1'),
  ];
}

// τ³-bench reads its own .env and never overrides variables already set, so Keeled's
// credentials are withheld from it rather than silently taking precedence.
function benchmarkEnv(): Record<string, string | undefined> {
  const withheld = /^(KEELED_|TYPESAFE_|OPENROUTER_|ANTHROPIC_|OPENAI_|AI_GATEWAY_)/;
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !withheld.test(key)));
}

async function healthy(url: string, process: Bun.Subprocess): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (process.exitCode !== null) return false;
    try {
      if ((await fetch(`${url}/health`)).ok) return true;
    } catch {
      await Bun.sleep(100);
    }
  }
  console.error(`The bridge did not become healthy at ${url}.`);
  return false;
}
