/**
 * The same agent against the real Jev controller and a real model.
 *
 * Set TYPESAFE_API_KEY, and KEELED_MODEL to any AI SDK model id
 * (for example "anthropic/claude-sonnet-4-5" or "openai/gpt-5"), which the
 * AI SDK gateway resolves. The harness itself is provider-agnostic: `model`
 * accepts any AI SDK LanguageModel.
 */
import { createAgent, planningTool } from '@keeled/core';
import { jev } from '@keeled/jev';
import { Repo } from './repo.ts';
import { buildTools } from './tools.ts';

const modelId = process.env['KEELED_MODEL'];
if (modelId === undefined) {
  console.error('Set KEELED_MODEL to an AI SDK model id, e.g. anthropic/claude-sonnet-4-5');
  process.exit(1);
}

const repo = new Repo([
  {
    path: 'src/pricing.ts',
    contents: 'export function priceLabel(cents: number) {\n  return `$${cents / 100}`;\n}\n',
  },
  { path: 'src/pricing.test.ts', contents: "import { formatPrice } from './pricing';\n" },
]);

const agent = createAgent({
  instructions: 'Complete the requested change and verify the result.',
  controller: jev(),
  model: modelId,
  tools: { plan: planningTool(), ...buildTools(repo) },
  planningTool: 'plan',
  policy: { maxSteps: 20 },
});

const result = await agent.run({
  messages: [
    {
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: 'Rename the price helper to formatPrice and make the tests pass.' }],
    },
  ],
});

console.log(`stop reason: ${result.stopReason}`);
console.log(`plan revision: ${result.plan?.version ?? 0}`);
console.log(`usage: ${JSON.stringify(result.usage)}`);
console.log(`\n${result.text}`);
