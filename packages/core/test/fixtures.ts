import { createAgent as createCoreAgent, type AgentConfig } from '../src/agent.ts';
import type { AgentToolSet } from '../src/tool.ts';
import { z } from 'zod';
import { agentTool } from '../src/tool.ts';
export function searchTool(results: string[] = ['src/index.ts']) {
  return agentTool({
    description: 'Search the repository.',
    inputSchema: z.object({ query: z.string() }),
    risk: 'read',
    resolveInput: context => ({ query: context.request.slice(0, 40) }),
    execute: ({ query }) => ({ query, files: results }),
  });
}

export function editTool(options: { failFirst?: boolean } = {}) {
  let calls = 0;
  return agentTool({
    description: 'Apply a change to a file.',
    inputSchema: z.object({ path: z.string(), change: z.string() }),
    risk: 'write',
    resolveInput: () => ({ path: 'src/index.ts', change: 'rename export' }),
    execute: ({ path }) => {
      calls += 1;
      if (options.failFirst === true && calls === 1) {
        throw new Error('export name not found in src/index.ts');
      }
      return { path, applied: true };
    },
  });
}

export function testTool(passing = true) {
  return agentTool({
    description: 'Run the test suite.',
    inputSchema: z.object({}),
    risk: 'write',
    resolveInput: () => ({}),
    execute: () => ({ passed: passing, failures: passing ? 0 : 2 }),
  });
}

/** These fixtures run against test-owned resources. Security tests use the raw constructor. */
export function createTestAgent<const T extends AgentToolSet>(config: AgentConfig<T>) {
  return createCoreAgent({
    access: { principal: { subject: 'fixture-owner' }, authorize: () => ({ allowed: true, reason: 'Test-owned resource' }) },
    ...config,
  });
}
