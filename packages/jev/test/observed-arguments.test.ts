import { expect, test } from 'bun:test';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { jevObservedArguments } from '../src/observed-arguments.ts';
import type { AgentContext, ObservedArgumentQuery } from '@keeled/core';

test('Jev adapter asks semantic closed-set questions and returns only observed option ids', async () => {
  let body: Record<string, unknown> | undefined;
  const client = new TypeSafeClient({
    apiKey: 'test-key',
    fetch: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: 'jev-test',
        answers: {
          source: { type: 'choice', choice: 'domain:0', confidence: 0.92, probabilities: { 'domain:0': 0.92, 'domain:1': 0.04, none_fit: 0.04 } },
          'member:value:0:0': { type: 'noul', noul: 0.97 },
          'member:value:0:1': { type: 'noul', noul: 0.96 },
          'member:value:1:0': { type: 'noul', noul: 0.02 },
        },
        usage: { input_tokens: 100, output_tokens: 12 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const query: ObservedArgumentQuery = {
    request: 'Open every canvas, not the palettes.',
    tool: { name: 'open_artifact', description: 'Open a design artifact.' },
    argument: { name: 'artifact_id', schema: { type: 'string' } },
    domains: [
      { id: 'domain:0', path: 'canvases[].tokens[]', sourceTool: 'list_work', description: 'Canvas tokens.', options: [
        { id: 'value:0:0', value: 'A-1', description: 'First canvas.', source: 'call:1', path: 'canvases[].tokens[]' },
        { id: 'value:0:1', value: 'A-2', description: 'Second canvas.', source: 'call:1', path: 'canvases[].tokens[]' },
      ] },
      { id: 'domain:1', path: 'palettes[]', sourceTool: 'list_work', description: 'Palette tokens.', options: [
        { id: 'value:1:0', value: 'P-1', description: 'A palette.', source: 'call:1', path: 'palettes[]' },
      ] },
    ],
  };
  const judge = jevObservedArguments({ client });
  const context = { abortSignal: new AbortController().signal } as AgentContext;
  expect(await judge(query, context)).toEqual({ domainId: 'domain:0', optionIds: ['value:0:0', 'value:0:1'], sourceConfidence: 0.92 });
  const questions = body?.['questions'] as Record<string, { instructions: string; criteria: Record<string, unknown> }>;
  expect(questions['source']?.instructions).toContain('Select by meaning and role, not by spelling similarity');
  expect(Object.keys(questions['source']?.criteria ?? {})).toEqual(['none_fit', 'domain:0', 'domain:1']);
  expect(questions['member:value:0:0']?.instructions).toContain('First canvas');
});

test('low-confidence and none-fit source answers yield no observed values', async () => {
  const client = new TypeSafeClient({
    apiKey: 'test-key',
    fetch: async () => new Response(JSON.stringify({
      model: 'jev-test',
      answers: {
        source: { type: 'choice', choice: 'none_fit', confidence: 0.99, probabilities: { 'domain:0': 0.01, none_fit: 0.99 } },
        'member:value:0:0': { type: 'noul', noul: 0.99 },
      },
      usage: { input_tokens: 20, output_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const query: ObservedArgumentQuery = {
    request: 'Open an unknown thing.', tool: { name: 'open', description: 'Open it.' },
    argument: { name: 'id', schema: { type: 'string' } }, domains: [{
      id: 'domain:0', path: 'others[]', sourceTool: 'list_others', description: 'Other values.', options: [
        { id: 'value:0:0', value: 'X', description: 'Other.', source: 'call:1', path: 'others[]' },
      ],
    }],
  };
  const context = { abortSignal: new AbortController().signal } as AgentContext;
  expect(await jevObservedArguments({ client })(query, context)).toEqual({ optionIds: [], sourceConfidence: 0.99 });
});

test('selecting a singleton observed domain copies its only member without a second semantic gate', async () => {
  const client = new TypeSafeClient({
    apiKey: 'test-key',
    fetch: async () => new Response(JSON.stringify({
      model: 'jev-test', answers: {
        source: { type: 'choice', choice: 'domain:0', confidence: 0.98, probabilities: { 'domain:0': 0.98, none_fit: 0.02 } },
        'member:value:0:0': { type: 'noul', noul: 0.1 },
      }, usage: { input_tokens: 20, output_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const query: ObservedArgumentQuery = {
    request: 'Track this package.', tool: { name: 'track', description: 'Track a package.' },
    argument: { name: 'tracking_id', schema: { type: 'string' } }, domains: [{
      id: 'domain:0', path: 'carrier_reference', sourceTool: 'get_package', description: 'The carrier reference.', options: [
        { id: 'value:0:0', value: 'PKG-1', description: 'The only package.', source: 'call:1', path: 'carrier_reference' },
      ],
    }],
  };
  const context = { abortSignal: new AbortController().signal } as AgentContext;
  expect(await jevObservedArguments({ client })(query, context)).toEqual({ domainId: 'domain:0', optionIds: ['value:0:0'], sourceConfidence: 0.98 });
});
