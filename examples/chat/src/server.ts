/**
 * The same execution served over HTTP as an AI SDK UI message stream.
 * Run with: bun run examples/chat/src/server.ts
 */
import { createAgent, planningTool, type AgentMessage } from '@keeled/core';
import { jev } from '@keeled/jev';
import { Repo } from './repo.ts';
import { buildTools } from './tools.ts';

const repo = new Repo([
  { path: 'src/pricing.ts', contents: 'export function priceLabel(cents: number) {}\n' },
]);

const agent = createAgent({
  instructions: 'Complete the requested change and verify the result.',
  controller: jev(),
  model: process.env['KEELED_MODEL'] ?? 'anthropic/claude-sonnet-4-5',
  tools: { plan: planningTool(), ...buildTools(repo) },
  planningTool: 'plan',
});

Bun.serve({
  port: 3000,
  async fetch(request) {
    if (request.method !== 'POST') return new Response('POST /', { status: 405 });
    const body = (await request.json()) as { messages: AgentMessage[] };
    const stream = agent.stream({ messages: body.messages, abortSignal: request.signal });
    return stream.toUIMessageStreamResponse();
  },
});

console.log('Listening on http://localhost:3000');
