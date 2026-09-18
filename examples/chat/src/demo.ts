/**
 * Offline demonstration of phase 1. No API keys are needed: a scripted controller
 * stands in for Jev and a stub model stands in for the LLM, so the execution path,
 * the plan revision and the termination paths are all exercised deterministically.
 */
import { agentTool, createAgent, type ControllerContext } from '@keeled/core';
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

const plans = [
  {
    objective: 'Rename the price helper and leave the suite passing',
    steps: [
      { id: 'locate', objective: 'Find the file that defines the price helper', dependencies: [] },
      { id: 'rename', objective: 'Rename the helper to formatPrice', dependencies: ['locate'] },
      { id: 'verify', objective: 'Run the tests', dependencies: ['rename'] },
    ],
  },
  {
    objective: 'Rename the price helper and leave the suite passing',
    steps: [
      { id: 'locate', objective: 'Find the file that defines the price helper', dependencies: [] },
      {
        id: 'rename',
        objective: 'Rename priceLabel to formatPrice in src/pricing.ts',
        dependencies: ['locate'],
      },
      { id: 'verify', objective: 'Run the tests', dependencies: ['rename'] },
    ],
  },
];

let planIndex = 0;
const plan = agentTool({
  description: 'Create or revise the plan.',
  inputSchema: z.object({ reason: z.string() }),
  risk: 'read',
  resolveInput: context => ({
    reason: context.state.blockers.at(-1)?.reason ?? 'no plan yet',
  }),
  execute: () => plans[Math.min(planIndex++, plans.length - 1)]!,
});

let editAttempt = 0;
const succeeded = (context: ControllerContext, tool: string) =>
  context.state.observations.some(o => o.kind === 'tool-result' && o.tool === tool);

const controller = scriptedController({
  decisions: [
    { type: 'tool', tool: 'plan' },
    { type: 'tool', tool: 'search', stepId: 'locate' },
    { type: 'tool', tool: 'editFile', stepId: 'rename' },
    { type: 'tool', tool: 'plan' },
    { type: 'tool', tool: 'readFile', stepId: 'rename' },
    { type: 'tool', tool: 'editFile', stepId: 'rename' },
    { type: 'tool', tool: 'runTests', stepId: 'verify' },
    { type: 'respond', outcome: 'completed' },
  ],
  assess: context => ({
    steps: {
      locate: { complete: succeeded(context, 'search') },
      rename: { complete: succeeded(context, 'editFile') },
      verify: { complete: succeeded(context, 'runTests') },
    },
    goalMet: succeeded(context, 'runTests'),
  }),
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
  tools: { plan, search: tools.search, readFile: tools.readFile, editFile, runTests: tools.runTests },
  planningTool: 'plan',
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
        ? `  decide  -> tool ${action.tool}${action.stepId ? ` (step ${action.stepId})` : ''}`
        : `  decide  -> respond ${action.outcome}`,
    );
  } else if (chunk.type === 'data-plan') {
    console.log(`  plan    -> revision ${chunk.data.version}: ${chunk.data.objective}`);
    for (const step of chunk.data.steps) console.log(`             - ${step.id}: ${step.objective}`);
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
console.log(`plan        : revision ${result.plan?.version ?? 0}`);
console.log(`statuses    : ${JSON.stringify(result.state.stepStatuses)}`);
console.log(`usage       : ${JSON.stringify(result.usage)}`);
console.log(`\n${result.text}`);
