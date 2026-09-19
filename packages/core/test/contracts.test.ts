import { describe, expect, test } from 'bun:test';
import { tool, type InferUITools, type UIMessage } from 'ai';
import { z } from 'zod';
import { createTestAgent as createAgent } from './fixtures.ts';
import { reduceState } from '../src/state.ts';
import { agentTool } from '../src/tool.ts';
import type { AgentDataParts, AgentMetadata } from '../src/types.ts';
import type { AgentContext, InferAgentUITools } from '../src/tool.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';
import { searchTool } from './fixtures.ts';

const model = stubModel({ text: 'Done.' });

const agentSearch = agentTool({
  description: 'Search.',
  inputSchema: z.object({ query: z.string() }),
  risk: 'read',
  resolveInput: () => ({ query: 'x' }),
  execute: ({ query }) => ({ hits: [query] }),
});

const sdkDouble = tool({
  description: 'Double a number.',
  inputSchema: z.object({ value: z.number() }),
  execute: async ({ value }) => ({ doubled: value * 2 }),
});

const tools = { agentSearch, sdkDouble };
type UITools = InferAgentUITools<typeof tools>;
type Message = UIMessage<AgentMetadata, AgentDataParts, UITools>;

describe('UI tool type projection', () => {
  test('keeps concrete names and input/output types for both tool forms', () => {
    const agentInput: UITools['agentSearch']['input'] = { query: 'x' };
    const agentOutput: UITools['agentSearch']['output'] = { hits: ['x'] };
    const sdkInput: UITools['sdkDouble']['input'] = { value: 2 };
    const sdkOutput: UITools['sdkDouble']['output'] = { doubled: 4 };

    const part: Message['parts'][number] = {
      type: 'tool-agentSearch',
      toolCallId: 'c1',
      state: 'output-available',
      input: agentInput,
      output: agentOutput,
    };

    expect(part.type).toBe('tool-agentSearch');
    expect(sdkInput.value).toBe(2);
    expect(sdkOutput.doubled).toBe(4);

    type SdkProjection = InferUITools<{ sdkDouble: typeof sdkDouble }>;
    const shared: SdkProjection['sdkDouble'] = sdkInput && { input: sdkInput, output: sdkOutput };
    expect(shared.output.doubled).toBe(4);
  });
});

describe('execution context', () => {
  test('agent callbacks get the agent context; SDK callbacks get the SDK context', async () => {
    let agentKeys: string[] = [];
    let sdkKeys: string[] = [];

    const inspected = agentTool({
      description: 'Records its context.',
      inputSchema: z.object({}),
      risk: 'read',
      resolveInput: (context: AgentContext) => {
        expect(typeof context.generateText).toBe('function');
        expect(context.request).toContain('Inspect');
        return {};
      },
      execute: (_input, context) => {
        agentKeys = Object.keys(context).sort();
        return { ok: true };
      },
    });

    const plain = tool({
      description: 'Records its context.',
      inputSchema: z.object({}),
      execute: async (_input, options) => {
        sdkKeys = Object.keys(options).sort();
        return { ok: true };
      },
    });

    const agent = createAgent({
      instructions: 'Inspect the context.',
      controller: scriptedController({
        decisions: [
          { type: 'tool', tool: 'inspected' },
          { type: 'tool', tool: 'plain' },
          { type: 'respond', outcome: 'completed' },
        ],

      }),
      model: stubModel({ text: 'Done.', objects: [{}] }),
      tools: { inspected, plain },
    });

    await agent.run({ messages: [userMessage('Inspect the context.')] });

    expect(agentKeys).toContain('generateObject');
    expect(agentKeys).toContain('state');
    expect(agentKeys).toContain('toolCallId');
    expect(sdkKeys).toEqual(['abortSignal', 'context', 'messages', 'toolCallId']);
  });
});

describe('terminal paths', () => {
  test('a controller failure ends the turn as an error with a response', async () => {
    const failing = {
      name: 'failing',
      async control() {
        throw new Error('controller unavailable');
      },
    };

    const agent = createAgent({
      instructions: 'Answer the question.',
      controller: failing,
      model,
      tools: { search: searchTool() },
    });

    const result = await agent.run({ messages: [userMessage('Go.')] });
    expect(result.stopReason).toBe('error');
    expect(result.text.length).toBeGreaterThan(0);
  });

  test('every non-cancelled stop reason produces text', async () => {
    const outcomes = ['completed', 'needs_input', 'blocked'] as const;
    for (const outcome of outcomes) {
      const agent = createAgent({
        instructions: 'Answer the question.',
        controller: scriptedController({
          decisions: [{ type: 'respond', outcome }],

        }),
        model,
        tools: { search: searchTool() },
      });
      const result = await agent.run({ messages: [userMessage('Go.')] });
      expect(result.stopReason).toBe(outcome);
      expect(result.text.length).toBeGreaterThan(0);
    }
  });

  test('a failed response generator still persists a status response', async () => {
    const agent = createAgent({
      instructions: 'Answer the question.',
      controller: scriptedController({
        decisions: [{ type: 'respond', outcome: 'completed' }],

      }),
      model,
      tools: { search: searchTool() },
      respond: async () => {
        throw new Error('response model unavailable');
      },
    });

    const result = await agent.run({ messages: [userMessage('Go.')] });
    expect(result.stopReason).toBe('completed');
    expect(result.text).toContain('could not be generated');
  });
});
