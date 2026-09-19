import { expect, test } from 'bun:test';
import { GenerationHost } from '../src/generation.ts';
import { modelTaskTracker } from '../src/task-tracker.ts';
import { createAgent } from '../src/agent.ts';
import { evidenceTool } from '../src/evidence.ts';
import { scriptedController, stubModel, userMessage } from '../src/testing.ts';
import type { AgentMessage, GenerationTrace } from '../src/types.ts';
import type { AgentContext } from '../src/tool.ts';

test('generation traces identify purpose and include failed calls', async () => {
  const traces: GenerationTrace[] = [];
  const host = new GenerationHost({ defaultModel: stubModel({ text: 'Ready.' }), abortSignal: new AbortController().signal,
    usage: { model: { calls: 0, inputTokens: 0, outputTokens: 0 }, controller: { calls: 0, inputTokens: 0, outputTokens: 0 } }, onGeneration: trace => traces.push(trace) });
  await host.generateText({ purpose: 'response', prompt: 'Answer.' });
  const abort = new AbortController(); abort.abort(new Error('Test cancellation'));
  await expect(host.generateText({ purpose: 'task_extract', prompt: 'Extract.', abortSignal: abort.signal })).rejects.toThrow();
  expect(traces).toMatchObject([{ purpose: 'response', status: 'success', structured: false }, { purpose: 'task_extract', status: 'error' }]);
  expect(traces[1]?.error).toBeTruthy();
});

test('task extraction uses the cheap model while verification retains the default', async () => {
  const cheap = stubModel(); const calls: Record<string, unknown>[] = [];
  const context = { state: { task: {}, observations: [] }, conversation: [], messages: [], request: 'Update my document.',
    generateObject: async (options: Record<string, unknown>) => { calls.push(options); return { object: { goals: [], constraints: [], withdrawals: [], checks: [] } }; },
  } as unknown as AgentContext;
  const tracker = modelTaskTracker({ extractionModel: cheap });
  await tracker.update(context); await tracker.verify(context);
  expect(calls[0]).toMatchObject({ purpose: 'task_extract', model: cheap, maxOutputTokens: 2048 });
  expect(calls[1]?.purpose).toBe('completion_verify');
  expect(calls[1]?.model).toBeUndefined();
});

test('identical evidence reads are suppressed after defaults normalize; another page runs', async () => {
  const history: AgentMessage[] = [{ id: 'old', role: 'assistant', parts: [{ type: 'tool-source', toolCallId: 'source', state: 'output-available', input: {}, output: Array.from({ length: 15 }, (_, id) => ({ id })) }] }];
  const tool = evidenceTool(); let executions = 0; let resolutions = 0;
  const inputs = [{ ref: 'source' }, { ref: 'source', page: 1, pageSize: 10, order: 'asc' as const }, { ref: 'source', page: 2 }];
  const result = await createAgent({ instructions: 'Read records.', model: stubModel(),
    controller: scriptedController({ decisions: [...inputs.map(() => ({ type: 'tool' as const, tool: 'inspect' })), { type: 'respond', outcome: 'completed' }] }),
    tools: { inspect: { ...tool, resolveInput: () => inputs[resolutions++]!, execute: (input: Parameters<typeof tool.execute>[0], context: Parameters<typeof tool.execute>[1]) => { executions++; return tool.execute(input, context); } } },
  }).run({ messages: [...history, userMessage('Read all records.')] });
  expect(executions).toBe(2);
  expect(result.state.blockers.some(b => b.kind === 'duplicate')).toBe(true);
  expect(result.state.observations.filter(o => o.kind === 'tool-result' && o.tool === 'inspect').map(o => (o.detail as { page: number }).page)).toEqual([1, 2]);
});
