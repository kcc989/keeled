import { z } from 'zod';
import { agentTool, type AgentTool } from './tool.ts';
import { callHistory } from './projection.ts';
import { jsonNumber, jsonObject, type JsonValue } from './json.ts';

const rawEvidenceSchema = z.object({
  ref: z.string().describe('The reference of an earlier tool result, as shown in the call history.'),
  path: z
    .string()
    .optional()
    .describe('Dot path to the list inside the result, when the result itself is not the list.'),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  sortBy: z
    .string()
    .optional()
    .describe(
      'Dot path to a number in each record to sort the full list by. A "[]" segment sums the value over ' +
        'every element of a list, such as each component of a product bundle: "[].prices.premium".',
    ),
  order: z.enum(['asc', 'desc']).optional(),
});

type EvidenceInput = z.infer<typeof rawEvidenceSchema>;

const evidenceInputSchema = rawEvidenceSchema.transform((input): EvidenceInput => ({
  ...input,
  page: input.page ?? 1,
  pageSize: input.pageSize ?? 10,
  order: input.order ?? 'asc',
}));

export interface EvidencePage {
  ref: string;
  path?: string;
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  sortBy?: string;
  order?: 'asc' | 'desc';
  /** Complete records with their position in the original list and, when sorted, their key. */
  records: { index: number; sortValue?: number | null; record: JsonValue }[];
}

/**
 * Reads a stored tool result by reference. It returns complete records a page at a time and
 * can sort the full list first, so a question such as "cheapest" is answered over every
 * candidate rather than over whatever part of a result a prompt could hold. Records whose
 * sort key is missing sort last with a null key.
 */
export function evidenceTool(): AgentTool<EvidenceInput, EvidencePage> {
  return agentTool({
    description:
      'Read an earlier tool result by its reference: a page of complete records, optionally sorted over the ' +
      'full result. Use it when the call history shows a result only in part, or to rank all candidates.',
    inputSchema: evidenceInputSchema,
    risk: 'read',
    repeat: 'reuse',
    execute: (input, context): EvidencePage => {
      const call = callHistory(context.conversation, context.state.observations).find(
        (record) => record.ref === input.ref,
      );

      if (call === undefined) throw new Error(`No tool result has the reference "${input.ref}".`);

      if (call.outcome !== 'result') throw new Error(`The call ${input.ref} failed, so it has no result to read.`);

      const list = input.path === undefined ? call.result : at(call.result, input.path);

      if (!Array.isArray(list)) {
        throw new Error(`${input.path === undefined ? 'That result' : `"${input.path}"`} is not a list.`);
      }

      let entries: EvidencePage['records'] = list.map((record, index) => ({ index, record }));
      const order = input.order ?? 'asc';

      if (input.sortBy !== undefined) {
        const path = input.sortBy;
        entries = entries
          .map((entry) => ({ ...entry, sortValue: numberAt(entry.record, path.split('.')) }))
          .sort((left, right) => {
            if (left.sortValue === null || left.sortValue === undefined) return 1;

            if (right.sortValue === null || right.sortValue === undefined) return -1;

            return order === 'asc' ? left.sortValue - right.sortValue : right.sortValue - left.sortValue;
          });
      }

      const pageSize = input.pageSize ?? 10;
      const pages = Math.max(1, Math.ceil(entries.length / pageSize));
      const page = Math.min(input.page ?? 1, pages);

      const result: EvidencePage = {
        ref: input.ref,
        total: entries.length,
        page,
        pages,
        pageSize,
        records: entries.slice((page - 1) * pageSize, page * pageSize),
      };

      if (input.path !== undefined) result.path = input.path;

      if (input.sortBy !== undefined) {
        result.sortBy = input.sortBy;
        result.order = order;
      }

      return result;
    },
  });
}

function at(value: JsonValue, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = value;

  for (const segment of path.split('.')) {
    if (current === undefined) return undefined;
    const object = jsonObject(current);

    if (object === undefined) return undefined;
    current = object[segment];
  }

  return current;
}

/** The number at a path, summing across a "[]" segment; null when any part is missing. */
function numberAt(value: JsonValue, segments: readonly string[]): number | null {
  if (segments.length === 0) return jsonNumber(value) ?? null;
  const [head, ...rest] = segments;

  if (head === '[]') {
    if (!Array.isArray(value) || value.length === 0) return null;
    let total = 0;

    for (const element of value) {
      const part = numberAt(element, rest);

      if (part === null) return null;
      total += part;
    }

    return total;
  }

  const object = jsonObject(value);

  if (object === undefined) return null;
  const child = object[head!];

  return child === undefined ? null : numberAt(child, rest);
}
