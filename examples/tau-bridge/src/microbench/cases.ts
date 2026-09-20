import type { ToolSpec } from '../tools.ts';
import { expandedCases } from './expanded.ts';
import type { JsonObject, JsonValue } from '@keeled/core';

export interface MicroCase {
  id: string;
  problem: string;
  domain: string;
  difficulty: 'simple' | 'intermediate' | 'complex';
  /** Candidate coverage is separate from user-scoped selection. Grader-only. */
  candidateExpected?: JsonObject[];
  request: string;
  tool: ToolSpec;
  evidence: JsonValue;
  /** Grader-only values. Never included in model context. */
  expected: JsonObject[];
  steps: number;
}

const object = (properties: JsonObject, required = Object.keys(properties)) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
});

const string = { type: 'string' };

const tool = (name: string, description: string, parameters: ToolSpec['parameters']): ToolSpec => ({
  name,
  description,
  parameters,
  risk: 'read',
});

const originalCases: Omit<MicroCase, 'domain' | 'difficulty'>[] = [
  {
    id: 'exact-records',
    problem: 'Copy complete related fields without crossing records.',
    request: 'Inspect each listed document version.',
    tool: tool(
      'inspect_document',
      'Read one document at its specified revision.',
      object({ document_id: string, revision: { type: 'integer' } }),
    ),
    evidence: [
      { document_id: 'D1', revision: 2 },
      { document_id: 'D2', revision: 7 },
    ],
    expected: [
      { document_id: 'D1', revision: 2 },
      { document_id: 'D2', revision: 7 },
    ],
    steps: 2,
  },
  {
    id: 'collection-ids',
    problem: 'Enumerate known IDs without asking the user to choose.',
    request: 'Inspect all documents in my workspace. You already have the list; look up each one.',
    tool: tool('read_document', 'Read a document by its document ID.', object({ document_id: string })),
    evidence: { workspace_id: 'W1', documents: ['D1', 'D2', 'D3'] },
    expected: ['D1', 'D2', 'D3'].map((document_id) => ({ document_id })),
    steps: 3,
  },
  {
    id: 'renamed-collection',
    problem: 'The same enumeration with a different vocabulary.',
    request: 'Inspect every device in this inventory.',
    tool: tool(
      'fetch_device',
      'Retrieve a device by its serial number. Inventory devices are listed by serial number.',
      object({ serial_number: string }),
    ),
    evidence: { devices: ['SN101', 'SN202'] },
    expected: ['SN101', 'SN202'].map((serial_number) => ({ serial_number })),
    steps: 2,
  },
  {
    id: 'described-alias',
    problem: 'Use a relationship stated in the tool contract.',
    request: 'Inspect this package.',
    tool: tool(
      'track_package',
      'Look up a package by tracking_id, which is the carrier_reference in shipment records.',
      object({ tracking_id: string }),
    ),
    evidence: { carrier_reference: 'PKG101', order_id: 'ORDER202' },
    expected: [{ tracking_id: 'PKG101' }],
    steps: 1,
  },
  {
    id: 'ambiguous-id',
    problem: 'Decline instead of inventing an identifier relationship.',
    request: 'Read the requested record. I have no further identifying information.',
    tool: tool('read_record', 'Read a record using its record_id.', object({ record_id: string })),
    evidence: { left: 'A101', right: 'B202' },
    expected: [],
    steps: 1,
  },
  {
    id: 'missing-related-field',
    problem: 'Do not combine unrelated IDs and revisions.',
    request: 'Inspect the document at its known revision; do not guess a revision.',
    tool: tool(
      'inspect_version',
      'Read document_id at revision. The revision must belong to that document.',
      object({ document_id: string, revision: { type: 'integer' } }),
    ),
    evidence: [{ document_id: 'D1' }, { document_id: 'D2', revision: 9 }],
    expected: [{ document_id: 'D2', revision: 9 }],
    steps: 1,
  },
  {
    id: 'nested-records',
    problem: 'Preserve record relationships inside nested collections.',
    request: 'Check stock for every listed product and warehouse pair.',
    tool: tool('stock', 'Read stock for a product SKU at a warehouse.', object({ sku: string, warehouse: string })),
    evidence: {
      groups: [
        {
          items: [
            { sku: 'SKU1', warehouse: 'north' },
            { sku: 'SKU2', warehouse: 'south' },
          ],
        },
      ],
    },
    expected: [
      { sku: 'SKU1', warehouse: 'north' },
      { sku: 'SKU2', warehouse: 'south' },
    ],
    steps: 2,
  },
  {
    id: 'root-ref',
    problem: 'Resolve required fields through a root schema reference.',
    request: 'Search for documents about solar energy.',
    tool: tool('search_documents', 'Search documents using a query.', {
      $ref: '#/$defs/Input',
      $defs: { Input: object({ query: string }) },
    }),
    evidence: { query: 'solar energy' },
    expected: [{ query: 'solar energy' }],
    steps: 1,
  },
  {
    id: 'required-summary',
    problem: 'Supply a required summary rather than empty arguments.',
    request: 'Prepare a support handoff with summary: Document export failed.',
    tool: tool('preview_handoff', 'Preview a handoff. A summary is required.', {
      $ref: '#/$defs/Input',
      $defs: { Input: object({ summary: string }) },
    }),
    evidence: { summary: 'Document export failed.' },
    expected: [{ summary: 'Document export failed.' }],
    steps: 1,
  },
  {
    id: 'missing-required',
    problem: 'Decline when a required argument has no source.',
    request: 'Read the report, but I do not know its ID.',
    tool: tool(
      'read_report',
      'Read a report by report_id. No listing operation is available.',
      object({ report_id: string }),
    ),
    evidence: { status: 'connected' },
    expected: [],
    steps: 1,
  },
];

const labels: [string, MicroCase['difficulty']][] = [
  ['documents', 'simple'],
  ['documents', 'intermediate'],
  ['inventory', 'intermediate'],
  ['logistics', 'intermediate'],
  ['records', 'intermediate'],
  ['documents', 'complex'],
  ['inventory', 'complex'],
  ['documents', 'complex'],
  ['support', 'complex'],
  ['records', 'simple'],
];

export const cases: MicroCase[] = [
  ...originalCases.map((item, i) => ({ ...item, domain: labels[i]![0], difficulty: labels[i]![1] })),
  ...expandedCases,
];
