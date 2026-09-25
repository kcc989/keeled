/**
 * Serves Keeled sessions over HTTP for an external benchmark harness.
 * Run with: bun run examples/tau-bridge/src/server.ts
 *
 *   PUT    /sessions/:id        { instructions, tools, history? }
 *   POST   /sessions/:id/user   { text }                 -> BridgeEvent
 *   POST   /sessions/:id/tool   { id, content, error? }  -> BridgeEvent
 *   DELETE /sessions/:id
 */
import { join } from 'node:path';
import { jev, type ToolGuideEvent } from '@keeled/jev';
import { jointController } from '@keeled/core';
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

const controllerName = process.env['KEELED_CONTROLLER'] ?? 'jev';

if (controllerName !== 'jev' && controllerName !== 'joint') {
  console.error('KEELED_CONTROLLER must be "jev" or "joint".');
  process.exit(1);
}

// Pinned so runs compare with recorded experiments; override with KEELED_JEV_MODEL.
const jevModel = process.env['KEELED_JEV_MODEL'] ?? 'jev-1.13.0';

const toolGuide = process.env['KEELED_TOOL_GUIDE'] === '1';

if (toolGuide && controllerName !== 'jev') {
  console.error('KEELED_TOOL_GUIDE applies only to the Jev controller.');
  process.exit(1);
}

const guideDirectory = process.env['KEELED_TOOL_GUIDE_DIR'];

const jevController = jev({ model: jevModel, toolGuide, onToolGuide: reportGuide });

const controller =
  controllerName === 'joint'
    ? jointController({ model: argumentsModel, authorize: jevController.authorize })
    : jevController;

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
        // SAFETY: the adjacent validation or framework contract establishes the asserted type.
        const body = (await request.json()) as Pick<SessionOptions, 'instructions' | 'tools' | 'history'>;
        sessions.get(id)?.close();
        sessions.set(
          id,
          new Session({
            instructions: body.instructions,
            tools: body.tools,
            history: body.history,
            controller,
            model,
            argumentsModel,
            writeArgumentsModel,
            jointInput: controllerName === 'joint',
            policy,
            settings: { controller: controllerName, jevModel, toolGuide },
          }),
        );

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
        // SAFETY: the adjacent validation or framework contract establishes the asserted type.
        const body = (await request.json()) as { text: string };

        return Response.json(await session.sendUser(body.text));
      }

      if (action === 'tool' && request.method === 'POST') {
        // SAFETY: the adjacent validation or framework contract establishes the asserted type.
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
  `Keeled bridge on http://localhost:${server.port} (${controllerName} controller, ${jevModel}${toolGuide ? ', tool guide' : ''}; OpenRouter model ${modelId} via ${providers.join(' → ')})`,
);

/** Logs each guide build and, when KEELED_TOOL_GUIDE_DIR is set, saves the guide for review. */
function reportGuide(event: ToolGuideEvent): void {
  if (event.type === 'failed') {
    console.error(`Tool guide ${event.key} failed after ${event.ms} ms: ${event.error}`);

    return;
  }

  const { guide } = event;
  const rules = guide.tools.reduce((total, entry) => total + entry.rules.length, 0);

  console.log(
    `Tool guide ${guide.key}: ${guide.segments.length} segments, ${rules} tool rules, ` +
      `${guide.usage.calls} Jev calls, ${guide.usage.inputTokens} input tokens, ${event.ms} ms`,
  );

  if (guideDirectory !== undefined) {
    const path = join(guideDirectory, `${guide.key}.json`);

    Bun.write(path, `${JSON.stringify(guide, null, 2)}\n`).catch((error) =>
      console.error(`Could not save tool guide to ${path}: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
}
