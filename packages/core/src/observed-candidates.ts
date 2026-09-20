import { jsonSchema } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { callHistory } from './projection.ts';
import type { AgentContext, CallCandidate, CandidateProvider } from './tool.ts';
import type { CandidateTool } from './candidates.ts';
import { isJsonValue, jsonObject, type JsonObject, type JsonValue } from './json.ts';
import { stableHash } from './ids.ts';

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
  sourceTool: string;
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
  sourceConfidence?: number;
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

export interface ObservedResolutionTrace {
  query: ObservedArgumentQuery;
  evidenceVersion: string;
  cacheHit: boolean;
  sourcePath?: string;
  sourceConfidence?: number;
  selectedOptions: readonly ObservedOption[];
  returnedOption?: ObservedOption;
}

export interface ObservedResolverOptions extends ObservedCandidateOptions {
  onResolution?: (trace: ObservedResolutionTrace) => void;
}

/**
 * Resolves one input only after the controller selects this tool. A successful judgment
 * leases the selected source relationship until every selected member has been returned.
 */
export function observedReadResolver(
  tool: CandidateTool,
  catalog: readonly CandidateTool[],
  judge: ObservedArgumentJudge,
  options: ObservedResolverOptions = {},
): ((context: AgentContext) => Promise<JsonValue>) | undefined {
  const prepared = prepare(tool, catalog, options);

  if (prepared === undefined) return undefined;
  const cache = new Map<string, CachedRelationship>();

  return async (context) => {
    const query = prepared.query(context);

    if (query === undefined) return undefined;

    const evidenceVersion = stable(
      query.domains.map((domain) => ({
        path: domain.path,
        sourceTool: domain.sourceTool,
        options: domain.options.map((option) => ({ value: option.value, source: option.source })),
      })),
    );

    const key = stable([tool.name, prepared.argumentName, context.request, evidenceVersion]);
    let relationship = cache.get(key);
    const cacheHit = relationship !== undefined;

    if (relationship === undefined) {
      const selection = await judge(query, context);
      const domain = query.domains.find((item) => item.id === selection.domainId);
      const selected = new Set(selection.optionIds);
      const alreadyUsed = prepared.alreadyUsed(context);
      relationship = {
        sourcePath: domain?.path,
        sourceConfidence: selection.sourceConfidence,
        selectedOptions:
          domain?.options.filter((option) => {
            if (!selected.has(option.id)) return false;
            const checked = prepared.schema.safeParse({ [prepared.argumentName]: option.value });

            return checked.success && isJsonValue(checked.data) && !alreadyUsed.has(stable(checked.data));
          }) ?? [],
        next: 0,
      };
      cache.set(key, relationship);
    }

    const option = relationship.selectedOptions[relationship.next];

    const checked =
      option === undefined ? undefined : prepared.schema.safeParse({ [prepared.argumentName]: option.value });

    const returnedOption = checked?.success === true && isJsonValue(checked.data) ? option : undefined;

    if (returnedOption !== undefined) relationship.next++;

    const trace: ObservedResolutionTrace = {
      query,
      evidenceVersion,
      cacheHit,
      sourcePath: relationship.sourcePath,
      sourceConfidence: relationship.sourceConfidence,
      selectedOptions: relationship.selectedOptions,
      returnedOption,
    };

    options.onResolution?.(trace);

    // SAFETY: the adjacent validation or framework contract establishes the asserted type.
    return returnedOption === undefined ? undefined : structuredClone(checked!.data as JsonValue);
  };
}

interface CachedRelationship {
  sourcePath?: string;
  sourceConfidence?: number;
  selectedOptions: readonly ObservedOption[];
  next: number;
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
  const prepared = prepare(tool, catalog, options);

  if (prepared === undefined) return undefined;

  return async (context) => {
    const query = prepared.query(context);

    if (query === undefined) return [];
    const selection = await judge(query, context);
    const domain = query.domains.find((item) => item.id === selection.domainId);

    if (domain === undefined) return [];
    const selected = new Set(selection.optionIds);
    const candidates: CallCandidate[] = [];

    for (const option of domain.options) {
      if (!selected.has(option.id)) continue;
      const checked = prepared.schema.safeParse({ [prepared.argumentName]: option.value });

      if (!checked.success || !isJsonValue(checked.data) || prepared.alreadyUsed(context).has(stable(checked.data)))
        continue;
      candidates.push({
        input: structuredClone(checked.data),
        description: `Call ${tool.name} with an observed value from ${domain.path}. ${option.description}`,
        sources: [option.source],
      });
    }

    return candidates;
  };
}

function prepare(tool: CandidateTool, catalog: readonly CandidateTool[], options: ObservedCandidateOptions) {
  if (tool.risk !== 'read') return undefined;
  const object = objectSchema(tool.parameters);

  if (object === undefined || object.required.length !== 1) return undefined;
  const argumentName = object.required[0]!;
  const argumentSchema = object.properties[argumentName];

  if (argumentSchema === undefined || !scalarTypes(argumentSchema).length) return undefined;
  let schema: z.ZodType;

  try {
    schema = z.fromJSONSchema(tool.parameters);
  } catch {
    return undefined;
  }

  const risks = new Map(catalog.map((entry) => [entry.name, entry.risk]));
  const maxDomains = options.maxDomains ?? 20;
  const maxOptions = options.maxOptions ?? 100;

  const fresh = (context: AgentContext) => {
    const history = callHistory(context.conversation, context.state.observations);
    const barrier = history.findLastIndex((call) => risks.get(call.tool) !== 'read');

    return history.slice(barrier + 1);
  };

  return {
    argumentName,
    schema,
    alreadyUsed: (context: AgentContext) =>
      new Set(
        fresh(context)
          .filter((call) => call.turn === 'current' && call.outcome === 'result' && call.tool === tool.name)
          .map((call) => stable(call.input)),
      ),
    query: (context: AgentContext): ObservedArgumentQuery | undefined => {
      // Results from the target tool are consequences of the relationship, not new source
      // evidence. Excluding them keeps the evidence version stable while a collection drains.
      const domains = observedDomains(
        fresh(context).filter((call) => call.tool !== tool.name),
        argumentSchema,
        maxDomains,
        maxOptions,
      );

      return domains.length === 0
        ? undefined
        : {
            request: context.request,
            tool: { name: tool.name, description: tool.description ?? tool.name },
            argument: { name: argumentName, schema: argumentSchema },
            domains,
          };
    },
  };
}

interface ObjectSchemaFields {
  properties: SchemaProperties;
  required: string[];
}

interface SchemaProperties {
  [name: string]: JsonSchema;
}

function objectSchema(schema: JsonSchema): ObjectSchemaFields | undefined {
  if (!isJsonValue(schema)) return undefined;
  const root = jsonObject(schema);

  if (root === undefined) return undefined;
  const resolved = resolveNode(root, root);

  if (resolved === undefined) return undefined;

  const allOf = resolved['allOf'];

  const pieces = Array.isArray(allOf)
    ? allOf.flatMap((piece) => {
        const object = jsonObject(piece);
        const resolvedPiece = object === undefined ? undefined : resolveNode(object, root);

        return resolvedPiece === undefined ? [] : [resolvedPiece];
      })
    : [resolved];

  const properties: SchemaProperties = {};
  const required = new Set<string>();

  for (const piece of pieces) {
    if (piece === undefined) continue;
    const pieceProperties = jsonObject(piece['properties']);

    if (pieceProperties !== undefined)
      for (const [name, value] of Object.entries(pieceProperties)) properties[name] = schemaValue(value);

    const pieceRequired = piece['required'];

    if (Array.isArray(pieceRequired)) for (const name of pieceRequired.filter(isString)) required.add(name);
  }

  return Object.keys(properties).length === 0 ? undefined : { properties, required: [...required] };
}

function resolveNode(node: JsonObject, root: JsonObject): JsonObject | undefined {
  const ref = node['$ref'];

  if (!isString(ref) || !ref.startsWith('#/')) return node;
  let current: JsonValue = root;

  for (const segment of ref.slice(2).split('/')) {
    const object = jsonObject(current);

    if (object === undefined) return undefined;
    current = object[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
  }

  return jsonObject(current);
}

function scalarTypes(schema: JsonSchema): string[] {
  if (!isJsonValue(schema)) return [];
  const node = jsonObject(schema);

  if (node === undefined) return [];
  const enumValues = node['enum'];

  if (Array.isArray(enumValues)) return [...new Set(enumValues.filter(isScalar).map(scalarKind))];
  const alternatives = Array.isArray(node['anyOf']) ? node['anyOf'] : node['oneOf'];

  if (Array.isArray(alternatives)) {
    return [...new Set(alternatives.map(schemaValue).flatMap(scalarTypes))];
  }

  const rawType = node['type'];
  const types = Array.isArray(rawType) ? rawType.filter(isString) : isString(rawType) ? [rawType] : [];

  return types.filter((type) => ['string', 'number', 'integer', 'boolean', 'null'].includes(type));
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
    sourceTool: group.sourceTool,
    description: `Values observed at ${group.path} in the result of ${group.sourceTool}.`,
    options: deduplicate(group.options),
  }));
}

type Visit = (value: Scalar, path: string, record: JsonObject | undefined) => void;

function walk(value: JsonValue, path: readonly string[], record: JsonObject | undefined, visit: Visit): void {
  if (Array.isArray(value)) {
    const normalized = [...path, '[]'];

    for (const item of value) {
      if (isScalar(item)) visit(item, showPath(normalized), record);
      else walk(item, normalized, undefined, visit);
    }

    return;
  }

  const own = jsonObject(value);

  if (own !== undefined) {
    for (const [field, inner] of Object.entries(own)) {
      if (isScalar(inner)) visit(inner, showPath([...path, field]), own);
      else walk(inner, [...path, field], own, visit);
    }
  }
}

function showPath(path: readonly string[]): string {
  return path.reduce(
    (text, segment) => (segment === '[]' ? `${text}[]` : text.length === 0 ? segment : `${text}.${segment}`),
    '',
  );
}

function isScalar(value: JsonValue): value is Scalar {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function compatible(value: Scalar, accepted: ReadonlySet<string>): boolean {
  if (value === null) return accepted.has('null');

  if (isNumber(value)) return Number.isFinite(value) && (accepted.has('number') || accepted.has('integer'));

  return accepted.has(scalarKind(value));
}

function describe(value: Scalar, path: string, record: JsonObject | undefined, tool: string): string {
  const siblings =
    record === undefined
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

  return options.filter((option) => {
    const key = stable(option.value);

    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
}

function stable(value: JsonValue): string {
  return stableHash(value);
}

function isString(value: JsonValue): value is string {
  return typeof value === 'string';
}

function isNumber(value: Scalar): value is number {
  return typeof value === 'number';
}

function scalarKind(value: Scalar): string {
  if (value === null) return 'null';

  if (isNumber(value)) return 'number';

  if (isString(value)) return 'string';

  return 'boolean';
}

function schemaValue(value: JsonValue): JsonSchema {
  // SAFETY: JsonSchema is represented as JSON, and this value passed JSON validation at the contract boundary.
  return value as JsonSchema;
}
