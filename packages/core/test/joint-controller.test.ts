import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createAgent } from '../src/agent.ts';
import { jointController } from '../src/joint-controller.ts';
import { agentTool } from '../src/tool.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';

describe('joint controller', () => {
  test('selects a prerequisite with complete input and skips argument generation', async () => {
    const traces: string[] = [];
    const inputs: unknown[] = [];

    const decisionModel = stubModel({
      toolCalls: [
        [{ toolName: 'find_record', input: { query: 'release notes' } }],
        [{ toolName: '__keeled_respond_completed', input: {} }],
      ],
    });

    const result = await createAgent({
      instructions: 'Find the record before applying any operation that needs its identifier.',
      controller: jointController({ model: decisionModel }),
      model: stubModel({ text: 'Found it.' }),
      onGeneration: (trace) => traces.push(trace.purpose),
      tools: {
        find_record: agentTool({
          description: 'Find a record by a supported search phrase.',
          inputSchema: z.object({ query: z.string() }),
          risk: 'read',
          execute: (input) => {
            inputs.push(input);

            return { id: 'record-1' };
          },
        }),
        apply_operation: agentTool({
          description: 'Apply the requested operation to a known record.',
          inputSchema: z.object({ id: z.string() }),
          risk: 'write',
          execute: () => ({ applied: true }),
        }),
      },
    }).run({ messages: [userMessage('Apply the operation to the release notes record.')] });

    expect(inputs).toEqual([{ query: 'release notes' }]);
    expect(result.stopReason).toBe('completed');
    expect(traces.filter((purpose) => purpose !== 'context_query')).toEqual([
      'joint_decision',
      'joint_decision',
      'response',
    ]);
    expect(result.usage.model.calls).toBe(3);
  });

  test('invalid names and extra calls do not execute and consume bounded work', async () => {
    let executions = 0;

    const decisionModel = stubModel({
      toolCalls: [
        [{ toolName: 'missing_tool', input: {} }],
        [
          { toolName: 'lookup', input: {} },
          { toolName: '__keeled_respond_completed', input: {} },
        ],
      ],
    });

    const result = await createAgent({
      instructions: 'Look it up.',
      controller: jointController({ model: decisionModel }),
      model: stubModel({ text: 'I could not continue.' }),
      tools: {
        lookup: agentTool({
          description: 'Look up the requested item.',
          inputSchema: z.object({}),
          risk: 'read',
          execute: () => {
            executions++;

            return { found: true };
          },
        }),
      },
      policy: { maxSteps: 2 },
    }).run({ messages: [userMessage('Look it up.')] });

    expect(executions).toBe(0);
    expect(result.stopReason).toBe('limit');
    expect(result.steps).toBe(2);
    expect(result.state.blockers.filter((blocker) => blocker.kind === 'controller_error')).toHaveLength(2);
    expect(result.usage.model.calls).toBe(3);
  });

  test('provider errors remain visible and consume bounded work', async () => {
    const result = await createAgent({
      instructions: 'Look it up.',
      controller: {
        name: 'failing-joint',
        inputMode: 'joint',
        control: async () => {
          throw new Error('provider unavailable');
        },
      },
      model: stubModel({ text: 'I could not continue.' }),
      tools: {
        lookup: agentTool({
          description: 'Look up the requested item.',
          inputSchema: z.object({}),
          risk: 'read',
          execute: () => ({ found: true }),
        }),
      },
      policy: { maxSteps: 2 },
    }).run({ messages: [userMessage('Look it up.')] });

    expect(result.stopReason).toBe('limit');
    expect(result.state.blockers.map((blocker) => blocker.reason)).toEqual([
      'Controller generation failed: provider unavailable',
      'Controller generation failed: provider unavailable',
    ]);
  });

  test('rejects custom resolvers instead of bypassing them', () => {
    expect(() =>
      createAgent({
        instructions: 'Look it up.',
        controller: jointController({ model: stubModel() }),
        model: stubModel(),
        tools: {
          lookup: agentTool({
            description: 'Look up one item.',
            inputSchema: z.object({ id: z.string() }),
            risk: 'read',
            resolveInput: () => ({ id: 'one' }),
            execute: () => ({ found: true }),
          }),
        },
      }),
    ).toThrow('does not support custom resolvers: lookup');
  });

  test('rejects per-tool model overrides instead of ignoring them', () => {
    expect(() =>
      createAgent({
        instructions: 'Look it up.',
        controller: jointController({ model: stubModel() }),
        model: stubModel(),
        tools: {
          lookup: agentTool({
            description: 'Look up one item.',
            inputSchema: z.object({ id: z.string() }),
            risk: 'read',
            model: stubModel(),
            execute: () => ({ found: true }),
          }),
        },
      }),
    ).toThrow('does not support per-tool model overrides: lookup');
  });
});

describe('complete call runtime path', () => {
  test('confirmation resumes the exact held input', async () => {
    const executed: unknown[] = [];

    const controller = scriptedController({
      decisions: [
        { type: 'tool_call', tool: 'publish', input: { document: 'draft-1' } },
        { type: 'respond', outcome: 'needs_input' },
        (context) => {
          const held = context.awaitingConfirmation[0]!;

          return { type: 'tool_call', tool: held.tool, input: held.input };
        },
        { type: 'respond', outcome: 'completed' },
      ],
      authorize: (_action, context) => ({
        permitted: true,
        confirmed: context.request === 'Yes, publish it.',
      }),
    });

    const agent = createAgent({
      instructions: 'Require confirmation before publishing.',
      controller,
      model: stubModel({ text: 'Done.' }),
      tools: {
        publish: agentTool({
          description: 'Publish a document.',
          inputSchema: z.object({ document: z.string() }),
          risk: 'write',
          execute: (input) => {
            executed.push(input);

            return { published: true };
          },
        }),
      },
    });

    const first = await agent.run({ messages: [userMessage('Publish draft-1.')] });
    expect(first.stopReason).toBe('needs_input');
    expect(executed).toEqual([]);

    const second = await agent.run({ messages: [...first.messages, userMessage('Yes, publish it.', 'user-2')] });
    expect(executed).toEqual([{ document: 'draft-1' }]);
    expect(second.stopReason).toBe('completed');
  });
});
