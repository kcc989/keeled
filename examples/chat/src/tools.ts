import { z } from 'zod';
import { agentTool } from '@keeled/core';
import type { Repo } from './repo.ts';

export function buildTools(repo: Repo) {
  const search = agentTool({
    description: 'Search the repository for files matching a term.',
    inputSchema: z.object({ query: z.string().describe('A file name fragment or identifier.') }),
    risk: 'read',
    execute: ({ query }) => ({
      query,
      matches: repo.search(query).map(file => file.path),
    }),
  });

  const readFile = agentTool({
    description: 'Read the contents of one file.',
    inputSchema: z.object({ path: z.string() }),
    risk: 'read',
    execute: ({ path }) => {
      const contents = repo.read(path);
      if (contents === undefined) throw new Error(`No such file: ${path}`);
      return { path, contents };
    },
  });

  const editFile = agentTool({
    description: 'Replace one identifier in one file.',
    inputSchema: z.object({ path: z.string(), from: z.string(), to: z.string() }),
    outputSchema: z.object({ path: z.string(), replacements: z.number() }),
    risk: 'write',
    execute: ({ path, from, to }) => repo.replace(path, from, to),
  });

  const runTests = agentTool({
    description: 'Run the test suite and report failures.',
    inputSchema: z.object({}),
    risk: 'write',
    resolveInput: () => ({}),
    execute: () => repo.runTests(),
  });

  return { search, readFile, editFile, runTests };
}
