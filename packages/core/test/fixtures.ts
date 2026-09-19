import { z } from 'zod';
import { agentTool } from '../src/tool.ts';
import type { PlanProposal } from '../src/plan.ts';
import type { AgentContext } from '../src/tool.ts';

export const firstPlan: PlanProposal = {
  objective: 'Apply the requested change and verify it',
  goals: [
    { id: 'locate', objective: 'Find the affected file', dependencies: [] },
    { id: 'edit', objective: 'Apply the change', dependencies: ['locate'] },
    { id: 'verify', objective: 'Run the tests', dependencies: ['edit'] },
  ],
};

export const revisedPlan: PlanProposal = {
  objective: 'Apply the requested change and verify it',
  goals: [
    { id: 'locate', objective: 'Find the affected file', dependencies: [] },
    { id: 'edit', objective: 'Apply the change with the correct export name', dependencies: ['locate'] },
    { id: 'verify', objective: 'Run the tests', dependencies: ['edit'] },
  ],
};

/** A planning tool with no model call, so the loop stays deterministic. */
export function scriptedPlanner(proposals: PlanProposal[]) {
  let index = 0;
  return agentTool({
    description: 'Create or revise the plan.',
    inputSchema: z.object({ reason: z.string() }),
    risk: 'read',
    resolveInput: (context: AgentContext) => ({
      reason: context.state.blockers.at(-1)?.reason ?? 'initial plan',
    }),
    execute: (): PlanProposal => {
      const proposal = proposals[Math.min(index, proposals.length - 1)];
      index += 1;
      if (proposal === undefined) throw new Error('No proposal scripted.');
      return proposal;
    },
  });
}

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
