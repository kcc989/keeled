import { describe, expect, test } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';
import { agentTool, isAgentTool, registerTools } from '../src/tool.ts';

const search = agentTool({
  description: 'Search external sources.',
  inputSchema: z.object({ query: z.string() }),
  risk: 'read',
  execute: async ({ query }) => ({ hits: [query] }),
});

describe('agentTool', () => {
  test('preserves input and output inference', () => {
    type Input = Parameters<typeof search.execute>[0];
    type Output = Awaited<ReturnType<typeof search.execute>>;
    const input: Input = { query: 'x' };
    const output: Output = { hits: ['x'] };
    expect(input.query).toBe('x');
    expect(output.hits).toEqual(['x']);
    expect(isAgentTool(search)).toBe(true);
  });

  test('defaults unspecified risk to unknown rather than read', () => {
    const anonymous = agentTool({
      description: 'No declared risk.',
      inputSchema: z.object({}),
      execute: () => 1,
    });
    expect(anonymous.risk).toBe('unknown');
  });
});

describe('registerTools', () => {
  test('accepts plain SDK function tools and marks them unknown risk', () => {
    const plain = tool({
      description: 'A plain SDK tool.',
      inputSchema: z.object({ value: z.number() }),
      execute: async ({ value }) => value * 2,
    });
    const registry = registerTools({ plain });
    expect(registry.get('plain')?.kind).toBe('sdk');
    expect(registry.get('plain')?.risk).toBe('unknown');
  });

  test('rejects reserved names', () => {
    expect(() => registerTools({ 'respond:completed': search })).toThrow(/reserved/);
  });

  test('rejects provider-executed tools', () => {
    const provider = {
      type: 'provider',
      id: 'acme.search',
      args: {},
      isProviderExecuted: true,
      inputSchema: z.object({}),
      execute: () => 1,
    };
    expect(() => registerTools({ provider: provider as never })).toThrow(/provider/);
  });

  test('rejects tools without an execute function', () => {
    const noExecute = {
      description: 'Client executed.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    };
    expect(() => registerTools({ noExecute: noExecute as never })).toThrow(/execute/);
  });

  test('rejects an empty tool map', () => {
    expect(() => registerTools({})).toThrow(/At least one tool/);
  });
});
