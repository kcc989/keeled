/**
 * Offline demonstration of phase 1. No API keys are needed: a scripted controller
 * stands in for Jev and a stub model stands in for the LLM, so the execution path,
 * failure recovery and the termination paths are all exercised deterministically.
 */
import { agentTool, createAgent } from '@keeled/core';
import { scriptedController, stubModel, userMessage } from '@keeled/core/testing';
import { z } from 'zod';
import { Repo } from './repo.ts';
import { buildTools } from './tools.ts';

const repo = new Repo([
  {
    path: 'src/pricing.ts',
    contents: 'export function priceLabel(cents: number) {\n  return `$${cents / 100}`;\n}\n',
  },
  { path: 'src/pricing.test.ts', contents: "import { formatPrice } from './pricing';\n" },
]);

const tools = buildTools(repo);

let editAttempt = 0;
const controller = scriptedController({
  decisions: [
    { type: 'tool', tool: 'search' },
    { type: 'tool', tool: 'editFile' },
    { type: 'tool', tool: 'readFile' },
    { type: 'tool', tool: 'editFile' },
    { type: 'tool', tool: 'runTests' },
    { type: 'respond', outcome: 'completed' },
  ],
});

const editFile = agentTool({
  description: tools.editFile.description as string,
  inputSchema: z.object({ path: z.string(), from: z.string(), to: z.string() }),
  risk: 'write',
  resolveInput: () => {
    editAttempt += 1;
    return editAttempt === 1
      ? { path: 'src/pricing.ts', from: 'formatPriceLabel', to: 'formatPrice' }
      : { path: 'src/pricing.ts', from: 'priceLabel', to: 'formatPrice' };
  },
  execute: input => repo.replace(input.path, input.from, input.to),
});

const agent = createAgent({
  instructions: 'Complete the requested change and verify the result.',
  controller,
  // `search` and `readFile` declare no input resolver, so the runtime generates their
  // input from the tool schema. The stub returns those two objects in order.
  model: stubModel({
    text: 'Renamed priceLabel to formatPrice in src/pricing.ts. The suite passes.',
    objects: [{ query: 'price' }, { path: 'src/pricing.ts' }],
  }),
  tools: { search: tools.search, readFile: tools.readFile, editFile, runTests: tools.runTests },
  policy: { maxSteps: 15 },
});

const execution = agent.stream({
  messages: [userMessage('Rename the price helper to formatPrice and make the tests pass.')],
});

for await (const chunk of execution) {
  if (chunk.type === 'data-decision') {
    const action = chunk.data.action;
    console.log(
      action.type === 'tool'
        ? `  decide  -> tool ${action.tool}`
        : `  decide  -> respond ${action.outcome}`,
    );
  } else if (chunk.type === 'data-blocker') {
    console.log(`  blocked -> ${chunk.data.reason}`);
  } else if (chunk.type === 'tool-output-error') {
    console.log(`  error   -> ${chunk.errorText}`);
  } else if (chunk.type === 'tool-output-available') {
    console.log(`  result  -> ${JSON.stringify(chunk.output)}`);
  }
}

const result = await execution.result;

console.log('\n---');
console.log(`stop reason : ${result.stopReason}`);
console.log(`steps       : ${result.steps}`);
console.log(`usage       : ${JSON.stringify(result.usage)}`);
console.log(`\n${result.text}`);
