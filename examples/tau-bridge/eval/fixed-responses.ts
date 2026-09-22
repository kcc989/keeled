/** Live response checks using generic execution-state fixtures, never benchmark tasks. */
import { resolve } from 'node:path';
import { respondWith, type ToolSpec } from '../src/tools.ts';
import { openRouterModels, providersFromEnvironment } from '../src/models.ts';
import { createContextStore, ingestSource } from '../../../packages/core/src/context.ts';
import { emptyState } from '../../../packages/core/src/state.ts';
import { GenerationHost } from '../../../packages/core/src/generation.ts';
import type { GenerationTrace, RespondContext, StopReason, UsageTotals } from '@keeled/core';

const [output, referencePath] = Bun.argv.slice(2);

const apiKey = process.env['OPENROUTER_API_KEY'];

const modelId = process.env['KEELED_MODEL'];

if (!output || !referencePath || !apiKey || !modelId)
  throw new Error('Use configured model credentials: bun fixed-responses.ts output.json reference-tools.ts');

const reference: typeof import('../src/tools.ts') = await import(resolve(referencePath));

const model = openRouterModels(modelId, apiKey, providersFromEnvironment()).argumentsModel;

const rows = [];

for (const setting of ['documents', 'supplies']) {
  const name = setting === 'documents' ? 'revise_document' : 'adjust_stock';

  const specs: ToolSpec[] = [
    {
      name,
      description: 'Apply the requested change to the specified record.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      risk: 'write',
    },
  ];

  const adapters = { reference: reference.respondWith(specs, model), candidate: respondWith(specs, model) };

  for (const status of ['denied', 'missing_evidence', 'confirmation', 'completed', 'scheduled'] as const) {
    const state = emptyState();

    const instructions =
      'Locked records cannot be changed, even with user confirmation. Check the current revision before writing. Ask for confirmation of exact changes. A tool may schedule work; a reply cannot. Report only observed outcomes.';

    const request = 'Yes, I confirm. Please proceed with the change to record R-17 now.';
    state.catalog = [
      ingestSource('instructions', 'instructions', instructions, 0),
      ingestSource('user:1', 'user', request, 1),
      ingestSource('assistant:proposal', 'assistant', 'I will apply the change to R-17 after you confirm.', 2),
    ];
    let stopReason: StopReason = 'needs_input';
    let expected = '';

    if (status === 'denied') {
      state.blockers.push({
        id: 'b1',
        cycle: 1,
        kind: 'policy_denied',
        tool: name,
        input: { id: 'R-17' },
        reason: 'R-17 is locked. The change was not executed.',
        resolution: 'Explain that this change is not permitted while the record is locked.',
      });
      expected =
        'Report that the change did not run because the record is locked; do not promise execution or ask for confirmation again.';
    } else if (status === 'missing_evidence') {
      state.blockers.push({
        id: 'b1',
        cycle: 1,
        kind: 'missing_evidence',
        tool: name,
        input: { id: 'R-17' },
        reason: 'The current revision is unknown. No write ran. No available tool can retrieve the revision.',
        resolution: 'Ask the user for the current revision before retrying.',
      });
      expected = 'Ask for the current revision; report no change yet and do not promise execution after this reply.';
    } else if (status === 'confirmation') {
      state.blockers.push({
        id: 'b1',
        cycle: 1,
        kind: 'needs_confirmation',
        tool: name,
        input: { id: 'R-18' },
        reason: 'R-17 was unavailable. The proposed replacement R-18 has not been confirmed. No write ran.',
        resolution: 'Ask the user to confirm changing R-18 instead of R-17.',
      });
      expected =
        'Ask about R-18 specifically; do not claim R-17 confirmation authorizes R-18 or promise to execute now.';
    } else {
      stopReason = 'completed';

      const content =
        status === 'completed'
          ? { id: 'R-17', status: 'updated', revision: 'v8' }
          : { id: 'R-17', status: 'queued', job: 'job-42', revision: 'v7' };

      const source = ingestSource('call:write', 'tool', content, 3);
      source.observation = { ref: 'write', tool: name, input: { id: 'R-17' } };
      state.catalog.push(source);
      state.observations.push({
        id: 'write',
        cycle: 1,
        kind: 'tool-result',
        tool: name,
        input: { id: 'R-17' },
        detail: content,
        summary:
          status === 'completed'
            ? 'The change succeeded.'
            : 'The change was queued as job-42; completion is not yet observed.',
      });
      expected =
        status === 'completed'
          ? 'Report the observed successful update and revision v8.'
          : 'Report the observed queue job-42 without claiming the update is complete. Do not deny that a job was scheduled.';
    }

    const modes: readonly ('reference' | 'candidate')[] =
      rows.length % 4 === 0 ? (['reference', 'candidate'] as const) : (['candidate', 'reference'] as const);

    for (const mode of modes) {
      const abortSignal = AbortSignal.timeout(60000);

      const usage: UsageTotals = {
        model: { calls: 0, inputTokens: 0, outputTokens: 0 },
        controller: { calls: 0, inputTokens: 0, outputTokens: 0 },
      };

      const traces: GenerationTrace[] = [];

      const generation = new GenerationHost({
        defaultModel: model,
        usage,
        abortSignal,
        onGeneration: (trace) => traces.push(trace),
      });

      const store = createContextStore({ snapshot: () => state.catalog, abortSignal, account: () => {} });

      const context: RespondContext = {
        store,
        request,
        instructions,
        stopReason,
        state,
        conversation: [],
        abortSignal,
        generateText: generation.generateText,
      };

      const start = performance.now();

      try {
        const result = await adapters[mode](context);
        rows.push({ setting, status, mode, expected, text: result.text, ms: performance.now() - start, usage, traces });
      } catch (error) {
        rows.push({
          setting,
          status,
          mode,
          expected,
          error: String(error),
          ms: performance.now() - start,
          usage,
          traces,
        });
      }

      await Bun.write(output, JSON.stringify({ model: modelId, rows }, null, 2) + '\n');
      console.log(setting, status, mode, 'complete');
    }
  }
}
