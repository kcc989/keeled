/** Live, fixed-input comparison. Synthetic fixtures are evaluation data only. */
import { resolve } from 'node:path';
import { jev } from '../../packages/jev/src/controller.ts';
import { ingestSource, type FactJudgmentRequest } from '../../packages/core/src/context.ts';

const [output, referencePath] = Bun.argv.slice(2);

if (!output || !referencePath) throw new Error('Usage: bun jev-layout.ts output.json reference-controller.ts');

const reference: typeof import('../../packages/jev/src/controller.ts') = await import(resolve(referencePath));

const judges = { reference: reference.jev().judgeFacts!, candidate: jev().judgeFacts! };

const rows = [];

for (const setting of ['files', 'stock']) {
  const candidates: FactJudgmentRequest['candidates'] = Array.from({ length: 48 }, (_, index) => {
    const content =
      setting === 'files'
        ? {
            path: `/documents/item-${index}.txt`,
            bytes: 2500 + index,
            description: `Document ${index}. ` + 'Exact path and byte count from the archive inspection. '.repeat(8),
          }
        : {
            code: `PART-${index}`,
            quantity: index + 7,
            description: `Bin ${index}. ` + 'Exact item code and quantity from the inventory inspection. '.repeat(8),
          };

    const source = ingestSource(`observed-${index}`, 'tool', content, index);

    return {
      fact: source.facts[0]!,
      source: {
        id: source.id,
        version: source.version,
        role: source.role,
        authority: source.authority,
        order: source.order,
      },
    };
  });

  for (const target of [3, 17, 29, 43, 999]) {
    const question =
      setting === 'files'
        ? `Find the byte count observed for exactly /documents/item-${target}.txt. Do not substitute other paths.`
        : `Find the quantity observed for exactly PART-${target}. Do not substitute other item codes.`;

    const order = rows.length % 4 === 0 ? (['reference', 'candidate'] as const) : (['candidate', 'reference'] as const);

    for (const mode of order) {
      const start = performance.now();

      try {
        const result = await judges[mode]({ question, candidates, abortSignal: AbortSignal.timeout(60000) });
        const selected = result.judgments.filter((j) => j.relevant >= 0.35 || j.contradicts >= 0.35).map((j) => j.id);
        const expected = target === 999 ? [] : [candidates[target]!.fact.id];
        rows.push({
          setting,
          target,
          mode,
          ms: performance.now() - start,
          usage: result.usage,
          selected,
          expected,
          exactSelection: JSON.stringify([...selected].sort()) === JSON.stringify([...expected].sort()),
          targetRetained: expected.every((id) => selected.includes(id)),
          scope: result.requiresCompleteScope,
        });
      } catch (error) {
        rows.push({ setting, target, mode, ms: performance.now() - start, error: String(error) });
      }

      await Bun.write(output, JSON.stringify({ rows }, null, 2) + '\n');
      console.log(setting, target, mode, 'complete');
    }
  }
}
