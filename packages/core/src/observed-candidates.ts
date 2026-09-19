import { jsonSchema } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { callHistory } from './projection.ts';
import type { AgentContext, CallCandidate, CandidateProvider } from './tool.ts';
import type { CandidateTool } from './candidates.ts';

type JsonSchema = Parameters<typeof jsonSchema>[0];
type Scalar = string | number | boolean | null;

/** One value in a turn-local, evidence-backed closed set. */
export interface ObservedOption {
  id: string;
  value: Scalar;
  description: string;
  source: string;
  path: string;
}

/** Values observed at the same result path. */
export interface ObservedDomain {
  id: string;
  path: string;
  description: string;
  options: readonly ObservedOption[];
}

export interface ObservedArgumentQuery {
  request: string;
  tool: { name: string; description: string };
  argument: { name: string; schema: JsonSchema };
  domains: readonly ObservedDomain[];
}

/** A judge selects a source domain and the members requested from it. */
export interface ObservedArgumentSelection {
  domainId?: string;
  optionIds: readonly string[];
}

export type ObservedArgumentJudge = (
  query: ObservedArgumentQuery,
  context: AgentContext,
) => ObservedArgumentSelection | PromiseLike<ObservedArgumentSelection>;

export interface ObservedCandidateOptions {
  /** Prevent one judgment from growing without bound. */
  maxDomains?: number;
  maxOptions?: number;
}

/**
 * Prepares read calls from a dynamic closed set of observed values. The judge interprets
 * meaning; this module owns provenance, freshness, exact copying, schema validation, and
 * deduplication. The first experiment is deliberately narrow: one required scalar argument.
 */
export function observedReadCandidates(
  tool: CandidateTool,
  catalog: readonly CandidateTool[],
  judge: ObservedArgumentJudge,
  options: ObservedCandidateOptions = {},
): CandidateProvider | undefined {
  if (tool.risk !== 'read') return undefined;
  const object = objectSchema(tool.parameters);
  if (object === undefined || object.required.length !== 1) return undefined;
  const argumentName = object.required[0]!;
  const argumentSchema = object.properties[argumentName];
  if (argumentSchema === undefined || !scalarTypes(argumentSchema).length) return undefined;

  let schema: z.ZodType;
  try { schema = z.fromJSONSchema(tool.parameters); } catch { return undefined; }
  const risks = new Map(catalog.map(entry => [entry.name, entry.risk]));
  const maxDomains = options.maxDomains ?? 20;
  const maxOptions = options.maxOptions ?? 100;

  return async context => {
    const history = callHistory(context.conversation, context.state.observations);
    // A mutation, including one with a lost response, makes earlier observed values stale.
    const barrier = history.findLastIndex(call => risks.get(call.tool) !== 'read');
    const fresh = history.slice(barrier + 1);
    const alreadyUsed = new Set(
      fresh
        .filter(call => call.turn === 'current' && call.outcome === 'result' && call.tool === tool.name)
        .map(call => stable(call.input)),
    );
    const domains = observedDomains(fresh, argumentSchema, maxDomains, maxOptions);
    if (domains.length === 0) return [];

    const selection = await judge({
      request: context.request,
      tool: { name: tool.name, description: tool.description ?? tool.name },
      argument: { name: argumentName, schema: argumentSchema },
      domains,
    }, context);
    const domain = domains.find(item => item.id === selection.domainId);
    if (domain === undefined) return [];
    const selected = new Set(selection.optionIds);
    const candidates: CallCandidate[] = [];
    for (const option of domain.options) {
      if (!selected.has(option.id)) continue;
      const checked = schema.safeParse({ [argumentName]: option.value });
      if (!checked.success || alreadyUsed.has(stable(checked.data))) continue;
      candidates.push({
        input: structuredClone(checked.data),
        description: `Call ${tool.name} with an observed value from ${domain.path}. ${option.description}`,
        sources: [option.source],
      });
    }
    return candidates;
  };
}

interface ObjectShape {
  properties: Record<string, JsonSchema>;
  required: string[];
}

function objectSchema(schema: JsonSchema): ObjectShape | undefined {
  const root = schema as Record<string, unknown>;
  const resolved = resolveNode(root, root);
  if (resolved === undefined) return undefined;
  const pieces = Array.isArray(resolved['allOf'])
    ? (resolved['allOf'] as Record<string, unknown>[]).map(piece => resolveNode(piece, root)).filter(Boolean)
    : [resolved];
  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  for (const piece of pieces) {
    if (piece === undefined) continue;
    Object.assign(properties, piece['properties'] as Record<string, JsonSchema> | undefined);
    for (const name of piece['required'] as string[] | undefined ?? []) required.add(name);
  }
  return Object.keys(properties).length === 0 ? undefined : { properties, required: [...required] };
}

function resolveNode(node: Record<string, unknown>, root: Record<string, unknown>): Record<string, unknown> | undefined {
  const ref = node['$ref'];
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  let current: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return current !== null && typeof current === 'object' ? current as Record<string, unknown> : undefined;
}

function scalarTypes(schema: JsonSchema): string[] {
  const node = schema as { type?: string | string[]; enum?: unknown[]; anyOf?: JsonSchema[]; oneOf?: JsonSchema[] };
  if (node.enum !== undefined) return [...new Set(node.enum.map(value => value === null ? 'null' : typeof value))];
  if (node.anyOf !== undefined || node.oneOf !== undefined) {
    return [...new Set((node.anyOf ?? node.oneOf ?? []).flatMap(scalarTypes))];
  }
  const types = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type];
  return types.filter(type => ['string', 'number', 'integer', 'boolean', 'null'].includes(type));
}

function observedDomains(
  history: ReturnType<typeof callHistory>,
  argumentSchema: JsonSchema,
  maxDomains: number,
  maxOptions: number,
): ObservedDomain[] {
  const accepted = new Set(scalarTypes(argumentSchema));
  const groups = new Map<string, { path: string; sourceTool: string; options: ObservedOption[] }>();
  let optionCount = 0;
  for (const call of history) {
    if (call.outcome !== 'result') continue;
    walk(call.result, [], undefined, (value, path, record) => {
      if (optionCount >= maxOptions || !compatible(value, accepted)) return;
      // Repeated pages from the same source tool form one dynamic domain. Each option keeps
      // its own call reference, so merging does not weaken provenance.
      const domainKey = `${call.tool}:${path}`;
      if (!groups.has(domainKey) && groups.size >= maxDomains) return;
      const group = groups.get(domainKey) ?? { path, sourceTool: call.tool, options: [] };
      const id = `value:${groups.size}:${group.options.length}`;
      group.options.push({
        id,
        value,
        description: describe(value, path, record, call.tool),
        source: call.ref,
        path,
      });
      groups.set(domainKey, group);
      optionCount++;
    });
  }
  return [...groups.values()].map((group, index) => ({
    id: `domain:${index}`,
    path: group.path,
    description: `Values observed at ${group.path} in the result of ${group.sourceTool}.`,
    options: deduplicate(group.options),
  }));
}

type Visit = (value: Scalar, path: string, record: Record<string, unknown> | undefined) => void;

function walk(value: unknown, path: readonly string[], record: Record<string, unknown> | undefined, visit: Visit): void {
  if (Array.isArray(value)) {
    const normalized = [...path, '[]'];
    for (const item of value) {
      if (isScalar(item)) visit(item, showPath(normalized), record);
      else walk(item, normalized, undefined, visit);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const own = value as Record<string, unknown>;
    for (const [field, inner] of Object.entries(own)) {
      if (isScalar(inner)) visit(inner, showPath([...path, field]), own);
      else walk(inner, [...path, field], own, visit);
    }
  }
}

function showPath(path: readonly string[]): string {
  return path.reduce((text, segment) => segment === '[]' ? `${text}[]` : text.length === 0 ? segment : `${text}.${segment}`, '');
}

function isScalar(value: unknown): value is Scalar {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function compatible(value: Scalar, accepted: ReadonlySet<string>): boolean {
  if (value === null) return accepted.has('null');
  if (typeof value === 'number') return Number.isFinite(value) && (accepted.has('number') || accepted.has('integer'));
  return accepted.has(typeof value);
}

function describe(value: Scalar, path: string, record: Record<string, unknown> | undefined, tool: string): string {
  const siblings = record === undefined
    ? []
    : Object.entries(record)
      .filter(([, sibling]) => isScalar(sibling) && sibling !== value)
      .slice(0, 5)
      .map(([field, sibling]) => `${field}=${String(sibling)}`);
  const context = siblings.length === 0 ? '' : ` Its record also has ${siblings.join(', ')}.`;
  return `${JSON.stringify(value)} observed at ${path} in ${tool}.${context}`;
}

function deduplicate(options: ObservedOption[]): ObservedOption[] {
  const seen = new Set<string>();
  return options.filter(option => {
    const key = stable(option.value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
