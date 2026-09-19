/**
 * Serves Keeled sessions over HTTP for an external benchmark harness.
 * Run with: bun run examples/tau-bridge/src/server.ts
 *
 *   PUT    /sessions/:id        { instructions, tools, history? }
 *   POST   /sessions/:id/user   { text }                 -> BridgeEvent
 *   POST   /sessions/:id/tool   { id, content, error? }  -> BridgeEvent
 *   DELETE /sessions/:id
 */
import { jev, jevObservedArguments } from '@keeled/jev';
import { openRouterModels, providersFromEnvironment } from './models.ts';
import { Session, SessionConflictError, type SessionOptions, type ToolResult } from './session.ts';

const modelId = process.env['KEELED_MODEL'];
const apiKey = process.env['OPENROUTER_API_KEY'];
if (!modelId || !apiKey) {
  console.error('Set OPENROUTER_API_KEY, and KEELED_MODEL to an OpenRouter model id, e.g. anthropic/claude-sonnet-4.5');
  process.exit(1);
}

const providers = providersFromEnvironment();
const { model, argumentsModel, writeArgumentsModel } = openRouterModels(modelId, apiKey, providers);
const controller = jev();
const observedArgumentJudge = process.env['KEELED_OBSERVED_ARGUMENTS'] === '1'
  ? jevObservedArguments()
  : undefined;
const policy = { generationTimeoutMs: 60_000, turnTimeoutMs: 240_000 };
const sessions = new Map<string, Session>();
const route = /^\/sessions\/([^/]+)(?:\/(user|tool))?$/;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env['KEELED_BRIDGE_PORT'] ?? 8787),
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, sessions: sessions.size });

    const match = route.exec(url.pathname);
    if (match === null) return new Response('Not found', { status: 404 });
    const id = decodeURIComponent(match[1] ?? '');
    const action = match[2];

    try {
      if (action === undefined && request.method === 'PUT') {
        const body = (await request.json()) as Pick<SessionOptions, 'instructions' | 'tools' | 'history'>;
        sessions.get(id)?.close();
        sessions.set(id, new Session({ instructions: body.instructions, tools: body.tools, history: body.history, controller, model, argumentsModel, writeArgumentsModel, observedArgumentJudge, policy }));
        return new Response(null, { status: 201 });
      }
      if (action === undefined && request.method === 'DELETE') {
        sessions.get(id)?.close();
        sessions.delete(id);
        return new Response(null, { status: 204 });
      }

      const session = sessions.get(id);
      if (session === undefined) return Response.json({ error: `Unknown session "${id}".` }, { status: 404 });

      if (action === 'user' && request.method === 'POST') {
        const body = (await request.json()) as { text: string };
        return Response.json(await session.sendUser(body.text));
      }
      if (action === 'tool' && request.method === 'POST') {
        const body = (await request.json()) as ToolResult;
        return Response.json(await session.sendToolResult(body));
      }
      return new Response('Method not allowed', { status: 405 });
    } catch (error) {
      const status = error instanceof SessionConflictError ? 409 : 500;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${id}] ${message}`);
      return Response.json({ error: message }, { status });
    }
  },
});

console.log(
  `Keeled bridge on http://localhost:${server.port} (OpenRouter model ${modelId} via ${providers.join(' → ')}; observed arguments ${observedArgumentJudge === undefined ? 'off' : 'on'})`,
);
