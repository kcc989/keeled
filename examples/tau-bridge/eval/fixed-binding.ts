/** Live argument-binding checks. Synthetic tool contracts never enter runtime defaults. */
import { resolve } from 'node:path';
import { resolveToolInput } from '../../../packages/core/src/input.ts';
import { MissingInformation } from '../../../packages/core/src/errors.ts';
import { createContextStore, ingestSource } from '../../../packages/core/src/context.ts';
import { emptyState } from '../../../packages/core/src/state.ts';
import { GenerationHost } from '../../../packages/core/src/generation.ts';
import type { AgentContext, GenerationTrace, UsageTotals } from '@keeled/core';
import { openRouterModels, providersFromEnvironment } from '../src/models.ts';
import type { ToolSpec } from '../src/tools.ts';

const [output, referencePath] = Bun.argv.slice(2);

const apiKey = process.env['OPENROUTER_API_KEY'];

const modelId = process.env['KEELED_MODEL'];

if (!output || !referencePath || !apiKey || !modelId)
  throw new Error('Supply model env, output path and reference input module.');

const reference: typeof import('../../../packages/core/src/input.ts') = await import(resolve(referencePath));

const model = openRouterModels(modelId, apiKey, providersFromEnvironment()).argumentsModel;

const resolvers = { reference: reference.resolveToolInput, candidate: resolveToolInput };

const rows = [];

for (const domain of ['documents', 'inventory']) {
  for (const variant of ['prerequisite', 'unconfirmed', 'denied', 'missing', 'ambiguous', 'repeat'] as const) {
    const writing = variant === 'unconfirmed' || variant === 'denied';

    const name =
      domain === 'documents'
        ? writing
          ? 'revise_record'
          : 'find_versions'
        : writing
          ? 'adjust_item'
          : 'inspect_options';

    const spec: ToolSpec = {
      name,
      description: writing
        ? domain === 'documents'
          ? 'Archive the document identified by id.'
          : 'Freeze the inventory record identified by id.'
        : 'Read current options and metadata for the record identified by id. Returned options can support a later change.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Exact target record identifier.' } },
        required: ['id'],
        additionalProperties: false,
      },
    };

    const instructions =
      'Read operations do not change records and do not require confirmation. Before a write, verify that the record is editable and obtain confirmation of the exact change. Locked records must not be changed. Repeat behavior is declared by the tool owner and enforced by the runtime.';

    const request =
      variant === 'missing'
        ? 'Inspect my record. I have not supplied its identifier.'
        : variant === 'ambiguous'
          ? 'Inspect one of the two records shown. I have not chosen which one.'
          : variant === 'repeat'
            ? 'Inspect R-17 again; I want a fresh check.'
            : writing
              ? domain === 'documents'
                ? 'Archive document R-17.'
                : 'Freeze inventory record R-17.'
              : 'Change record R-17 to a better available option.';

    const state = emptyState();
    state.catalog = [
      ingestSource('instructions', 'instructions', instructions, 0),
      ingestSource('user:1', 'user', request, 1),
    ];

    if (variant === 'ambiguous')
      state.catalog.push(ingestSource('call:records', 'tool', [{ id: 'R-17' }, { id: 'R-18' }], 2));

    if (variant === 'denied') {
      state.catalog.push(ingestSource('call:locked', 'tool', { id: 'R-17', editable: false }, 2));
      state.blockers.push({
        id: 'b1',
        cycle: 1,
        kind: 'policy_denied',
        tool: name,
        input: { id: 'R-17' },
        reason: 'R-17 is locked. No write may run.',
        resolution: 'Explain the denial.',
      });
    }

    if (variant === 'unconfirmed')
      state.blockers.push({
        id: 'b1',
        cycle: 1,
        kind: 'needs_confirmation',
        tool: name,
        input: { id: 'R-17' },
        reason: 'The change has not been confirmed.',
        resolution: 'Ask for confirmation before executing.',
      });

    if (variant === 'repeat') {
      const content = { id: 'R-17', options: ['old'] };
      const source = ingestSource('call:prior', 'tool', content, 2);
      source.observation = { ref: 'prior', tool: name, input: { id: 'R-17' } };
      state.catalog.push(source);
      state.observations.push({
        id: 'prior',
        cycle: 1,
        kind: 'tool-result',
        tool: name,
        input: { id: 'R-17' },
        detail: content,
        summary: 'Previous inspection returned old options.',
      });
    }

    const modes: readonly ('reference' | 'candidate')[] =
      rows.length % 4 === 0 ? ['reference', 'candidate'] : ['candidate', 'reference'];

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

      const context: AgentContext = {
        store,
        instructions,
        request,
        state,
        action: { tool: name },
        conversation: [],
        messages: [],
        abortSignal,
        generateText: generation.generateText,
        generateObject: generation.generateObject,
      };

      const expectedMissing = variant === 'missing' || variant === 'ambiguous';
      const start = performance.now();

      try {
        const args = await resolvers[mode](spec, context, model);
        rows.push({
          domain,
          variant,
          mode,
          status: 'ready',
          args,
          correct: !expectedMissing && JSON.stringify(args) === JSON.stringify({ id: 'R-17' }),
          ms: performance.now() - start,
          usage,
          traces,
        });
      } catch (error) {
        const missing =
          error instanceof MissingInformation || (error instanceof Error && error.name === 'MissingInformation');

        rows.push({
          domain,
          variant,
          mode,
          status: missing ? 'missing' : 'error',
          error: String(error),
          correct: missing && expectedMissing,
          ms: performance.now() - start,
          usage,
          traces,
        });
      }

      await Bun.write(output, JSON.stringify({ model: modelId, rows }, null, 2) + '\n');
      console.log(domain, variant, mode, 'complete');
    }
  }
}
