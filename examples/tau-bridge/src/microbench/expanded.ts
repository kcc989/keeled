import type { MicroCase } from './cases.ts';
import type { ToolSpec } from '../tools.ts';

const str = { type: 'string' };
const int = { type: 'integer' };
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const list = (items: unknown) => ({ type: 'array', items });
function example(id: string, domain: string, difficulty: MicroCase['difficulty'], problem: string, request: string,
  description: string, parameters: ToolSpec['parameters'], evidence: unknown, expected: Record<string, unknown>[],
  candidateExpected?: Record<string, unknown>[]): MicroCase {
  return { id, domain, difficulty, problem, request, tool: { name: id.replaceAll('-', '_'), description, parameters, risk: 'read' }, evidence, expected,
    steps: Math.max(1, expected.length), ...(candidateExpected === undefined ? {} : { candidateExpected }) };
}

export const expandedCases: MicroCase[] = [
  // Library: literal input, ID collections, keyed records, ambiguity.
  example('library-isbn', 'library', 'simple', 'Preserve leading zeros in identifiers.', 'Look up this book.',
    'Read a book by its ISBN string.', obj({ isbn: str }), { isbn: '0001234567890' }, [{ isbn: '0001234567890' }]),
  example('library-loans', 'library', 'intermediate', 'Enumerate a named collection of scalar IDs.', 'Inspect all my loans.',
    'Read a loan by loan_id. The loans collection contains loan IDs.', obj({ loan_id: str }), { patron_id: 'P9', loans: ['L10', 'L20', 'L30'] }, ['L10', 'L20', 'L30'].map(loan_id => ({ loan_id }))),
  example('library-keyed-copies', 'library', 'complex', 'Use object keys as IDs while preserving associated branches.', 'Inspect every listed copy at its branch.',
    'Read copy_id at branch. The copies object is keyed by copy_id.', obj({ copy_id: str, branch: str }),
    { copies: { C01: { branch: 'east' }, C02: { branch: 'west' } } }, [{ copy_id: 'C01', branch: 'east' }, { copy_id: 'C02', branch: 'west' }]),
  example('library-ambiguous-title', 'library', 'intermediate', 'Decline when a title identifies multiple editions.', 'Read the edition called Atlas. I do not know which edition.',
    'Read the single edition requested by edition_id. A title alone does not distinguish editions.', obj({ edition_id: str }),
    { editions: [{ edition_id: 'E1', title: 'Atlas' }, { edition_id: 'E2', title: 'Atlas' }] }, [], [{ edition_id: 'E1' }, { edition_id: 'E2' }]),

  // Retail: arrays, nested inputs, duplicates, unknown enum values.
  example('retail-single-order', 'retail', 'simple', 'Ignore unrelated fields.', 'Inspect this order.',
    'Read an order by order_id.', obj({ order_id: str }), { order_id: 'O11', customer_id: 'C99', total: 42 }, [{ order_id: 'O11' }]),
  example('retail-batch-orders', 'retail', 'intermediate', 'Pass a whole ID array when the tool supports batching.', 'Read these three orders in one call, in the listed order.',
    'Read a batch of orders using order_ids.', obj({ order_ids: list(str) }), { order_ids: ['O1', 'O2', 'O3'] }, [{ order_ids: ['O1', 'O2', 'O3'] }]),
  example('retail-line-items', 'retail', 'complex', 'Construct nested input from a declared outer relationship.', 'Inspect each line item in this order.',
    'Read a line using order_id and item containing sku and line_number. All lines belong to their containing order.', obj({ order_id: str, item: obj({ sku: str, line_number: int }) }),
    { order_id: 'O7', lines: [{ sku: 'A', line_number: 1 }, { sku: 'B', line_number: 2 }] }, [{ order_id: 'O7', item: { sku: 'A', line_number: 1 } }, { order_id: 'O7', item: { sku: 'B', line_number: 2 } }]),
  example('retail-unknown-state', 'retail', 'intermediate', 'Do not invent a mapping to a restricted enum.', 'Find orders with the recorded status. Do not substitute another status.',
    'Filter by status, which must match one of the supported values exactly.', obj({ status: { type: 'string', enum: ['open', 'closed'] } }),
    { status: 'pending_review' }, []),

  // Logistics: aliases, associated dates, joins, missing units.
  example('logistics-tracking', 'logistics', 'simple', 'Copy a literal ID.', 'Track the package with tracking_id PKG-808.',
    'Read delivery status for tracking_id.', obj({ tracking_id: str }), { tracking_id: 'PKG-808' }, [{ tracking_id: 'PKG-808' }]),
  example('logistics-related-dates', 'logistics', 'intermediate', 'Keep each checkpoint ID attached to its own date.', 'Inspect both dated checkpoints.',
    'Read checkpoint_id on date.', obj({ checkpoint_id: str, date: str }),
    [{ checkpoint_id: 'CP1', date: '2026-01-04' }, { checkpoint_id: 'CP2', date: '2026-01-05' }], [{ checkpoint_id: 'CP1', date: '2026-01-04' }, { checkpoint_id: 'CP2', date: '2026-01-05' }]),
  example('logistics-explicit-join', 'logistics', 'complex', 'Join records only through a stated foreign key.', 'Inspect each package at its assigned depot.',
    'Read package_id with depot_code. Package depot_id references depots.id; use that depot record code.', obj({ package_id: str, depot_code: str }),
    { packages: [{ package_id: 'P1', depot_id: 'D2' }, { package_id: 'P2', depot_id: 'D1' }], depots: [{ id: 'D1', code: 'north' }, { id: 'D2', code: 'south' }] },
    [{ package_id: 'P1', depot_code: 'south' }, { package_id: 'P2', depot_code: 'north' }]),
  example('logistics-missing-unit', 'logistics', 'intermediate', 'A quantity without units is insufficient.', 'Preview the shipping quote for this parcel. Do not guess its weight unit.',
    'Preview a quote for weight and unit. Both must be known.', obj({ weight: { type: 'number' }, unit: { type: 'string', enum: ['kg', 'lb'] } }),
    { weight: 12 }, []),

  // DevOps: booleans, composite keys, references, conflicting evidence.
  example('devops-false-flag', 'devops', 'simple', 'Preserve false rather than treating it as missing.', 'Inspect the service with the recorded settings.',
    'Read service_id with include_logs set to the provided boolean.', obj({ service_id: str, include_logs: { type: 'boolean' } }),
    { service_id: 'S1', include_logs: false }, [{ service_id: 'S1', include_logs: false }]),
  example('devops-composite-key', 'devops', 'intermediate', 'The same name in different namespaces denotes separate resources.', 'Inspect both named deployments.',
    'Read deployment name within namespace.', obj({ name: str, namespace: str }), [{ name: 'api', namespace: 'test' }, { name: 'api', namespace: 'prod' }],
    [{ name: 'api', namespace: 'test' }, { name: 'api', namespace: 'prod' }]),
  example('devops-nested-ref', 'devops', 'complex', 'Validate an input object whose nested property uses a schema reference.', 'Inspect this target.',
    'Read a target identified by cluster and resource.', { ...obj({ target: { $ref: '#/$defs/Target' } }), $defs: { Target: obj({ cluster: str, resource: str }) } },
    { target: { cluster: 'c1', resource: 'r1' } }, [{ target: { cluster: 'c1', resource: 'r1' } }]),
  example('devops-conflicting-version', 'devops', 'complex', 'Decline a current-version request when equally authoritative observations conflict.', 'Read the current version of service S1. The observations have equal authority; do not guess which is current.',
    'Read service_id at version. Use the known current version only.', obj({ service_id: str, version: int }),
    [{ service_id: 'S1', version: 4 }, { service_id: 'S1', version: 5 }], [], [{ service_id: 'S1', version: 4 }, { service_id: 'S1', version: 5 }]),

  // Scheduling: strings, nullable values, scoped selection, unsupported conversion.
  example('calendar-literal-timezone', 'calendar', 'simple', 'Preserve the supplied timezone string.', 'Read this calendar in the specified timezone.',
    'Read calendar_id in timezone.', obj({ calendar_id: str, timezone: str }), { calendar_id: 'C1', timezone: 'America/New_York' }, [{ calendar_id: 'C1', timezone: 'America/New_York' }]),
  example('calendar-explicit-null', 'calendar', 'intermediate', 'Preserve an explicit null accepted by the contract.', 'Inspect this event with its recorded recurrence.',
    'Read event_id with recurrence. Null means the event does not recur.', obj({ event_id: str, recurrence: { anyOf: [str, { type: 'null' }] } }),
    { event_id: 'E1', recurrence: null }, [{ event_id: 'E1', recurrence: null }]),
  example('calendar-owner-scope', 'calendar', 'complex', 'Select only records within the requested owner scope.', 'Inspect only Ada’s events. Do not inspect Ben’s.',
    'Read event_id. Event records identify owner.', obj({ event_id: str }), [{ event_id: 'E1', owner: 'Ada' }, { event_id: 'E2', owner: 'Ben' }, { event_id: 'E3', owner: 'Ada' }],
    [{ event_id: 'E1' }, { event_id: 'E3' }], [{ event_id: 'E1' }, { event_id: 'E2' }, { event_id: 'E3' }]),
  example('calendar-unknown-timezone', 'calendar', 'intermediate', 'Do not infer a timezone from an unqualified local time.', 'Look up slots at the recorded local time. I do not know the timezone.',
    'Read available slots at local_time and timezone; both must be supplied.', obj({ local_time: str, timezone: str }), { local_time: '09:30' }, []),

  // Accounting: zero, exact numeric strings, allOf schemas, incompatible identifiers.
  example('accounting-zero-offset', 'accounting', 'simple', 'Zero is a valid value.', 'Read the first page of the ledger.',
    'Read ledger_id at numeric offset.', obj({ ledger_id: str, offset: int }), { ledger_id: 'L1', offset: 0 }, [{ ledger_id: 'L1', offset: 0 }]),
  example('accounting-decimal-string', 'accounting', 'intermediate', 'Preserve exact decimal strings without rounding.', 'Preview the recorded amount in the stated currency.',
    'Preview amount as an exact decimal string and currency as provided.', obj({ amount: str, currency: str }), { amount: '9007199254740993.01', currency: 'USD' }, [{ amount: '9007199254740993.01', currency: 'USD' }]),
  example('accounting-allof', 'accounting', 'complex', 'Resolve required fields combined through allOf.', 'Read this statement for the specified period.',
    'Read a statement by account_id and period.', { type: 'object', allOf: [{ type: 'object', properties: { account_id: str }, required: ['account_id'] }, { type: 'object', properties: { period: str }, required: ['period'] }] },
    { account_id: 'A1', period: '2026-01' }, [{ account_id: 'A1', period: '2026-01' }]),
  example('accounting-wrong-id-kind', 'accounting', 'intermediate', 'Do not substitute an account ID for an invoice ID.', 'Read my invoice, but I do not have its invoice ID.',
    'Read an invoice by invoice_id; account_id is not an invoice ID.', obj({ invoice_id: str }), { account_id: 'A100' }, []),

  // Education: user-provided inputs, exact enum, shared parent fields, duplicate IDs.
  example('education-request-only', 'education', 'simple', 'Use an argument stated by the user rather than returned by a tool.', 'Read course CS101.',
    'Read course_id.', obj({ course_id: str }), { connected: true }, [{ course_id: 'CS101' }], []),
  example('education-enum', 'education', 'simple', 'Copy an enum value exactly.', 'Read the course for the recorded term.',
    'Read course_id in term.', obj({ course_id: str, term: { type: 'string', enum: ['spring', 'summer', 'fall'] } }), { course_id: 'CS2', term: 'fall' }, [{ course_id: 'CS2', term: 'fall' }]),
  example('education-parent-scope', 'education', 'complex', 'Inherit an explicitly defined parent field without crossing groups.', 'Inspect all sections in both departments.',
    'Read section_id within department_id. Sections belong to their containing department.', obj({ department_id: str, section_id: str }),
    { departments: [{ department_id: 'D1', sections: [{ section_id: 'S1' }, { section_id: 'S2' }] }, { department_id: 'D2', sections: [{ section_id: 'S1' }] }] },
    [{ department_id: 'D1', section_id: 'S1' }, { department_id: 'D1', section_id: 'S2' }, { department_id: 'D2', section_id: 'S1' }]),
  example('education-deduplicate', 'education', 'intermediate', 'Inspect each unique ID once even if the source repeats it.', 'Inspect each distinct course once.',
    'Read course_id.', obj({ course_id: str }), [{ course_id: 'C1' }, { course_id: 'C1' }, { course_id: 'C2' }], [{ course_id: 'C1' }, { course_id: 'C2' }]),

  // Clinic administration only: no medical judgments.
  example('clinic-appointment', 'clinic-admin', 'simple', 'Copy an appointment identifier.', 'Read this appointment.',
    'Read appointment_id.', obj({ appointment_id: str }), { appointment_id: 'AP1' }, [{ appointment_id: 'AP1' }]),
  example('clinic-optional-field', 'clinic-admin', 'intermediate', 'Omit an unknown optional field instead of fabricating it.', 'Read appointment AP2. I do not know the location code.',
    'Read appointment_id, optionally narrowed by location_code when known.', obj({ appointment_id: str, location_code: str }, ['appointment_id']), { appointment_id: 'AP2' }, [{ appointment_id: 'AP2' }]),
  example('clinic-ref-array', 'clinic-admin', 'complex', 'Preserve a batch of nested referenced objects.', 'Read these appointment references in the recorded order.',
    'Read a batch of appointment references.', { ...obj({ appointments: list({ $ref: '#/$defs/Appointment' }) }), $defs: { Appointment: obj({ appointment_id: str, clinic_id: str }) } },
    { appointments: [{ appointment_id: 'AP1', clinic_id: 'CL1' }, { appointment_id: 'AP2', clinic_id: 'CL2' }] }, [{ appointments: [{ appointment_id: 'AP1', clinic_id: 'CL1' }, { appointment_id: 'AP2', clinic_id: 'CL2' }] }]),
  example('clinic-missing-identity', 'clinic-admin', 'intermediate', 'A display name is not an established record identifier.', 'Read Alex’s appointment. I do not have an appointment ID.',
    'Read appointment_id; display names are not identifiers.', obj({ appointment_id: str }), { display_name: 'Alex' }, []),

  // Media: Unicode, nested batch payloads, discriminator branches, null rejection.
  example('media-unicode', 'media', 'simple', 'Preserve Unicode text without translation.', 'Search for the exact title returned by the catalog.',
    'Search a title string exactly as supplied.', obj({ title: str }), { title: '雨の図書館 — Café' }, [{ title: '雨の図書館 — Café' }]),
  example('media-nested-filter', 'media', 'intermediate', 'Copy a structured filter intact.', 'Search with this filter.',
    'Search using filter containing creator and tags.', obj({ filter: obj({ creator: str, tags: list(str) }) }), { filter: { creator: 'Ada', tags: ['audio', 'archive'] } }, [{ filter: { creator: 'Ada', tags: ['audio', 'archive'] } }]),
  example('media-discriminated-ref', 'media', 'complex', 'Choose the schema branch matching a supplied discriminator.', 'Inspect the recorded asset.',
    'Read an asset. Images require width; audio requires duration_seconds.', { type: 'object', oneOf: [obj({ kind: { const: 'image' }, asset_id: str, width: int }), obj({ kind: { const: 'audio' }, asset_id: str, duration_seconds: int })] },
    { kind: 'audio', asset_id: 'A1', duration_seconds: 90 }, [{ kind: 'audio', asset_id: 'A1', duration_seconds: 90 }]),
  example('media-null-id', 'media', 'simple', 'Null does not satisfy a required string ID.', 'Read this asset if its ID is known.',
    'Read asset_id. Do not invent a missing identifier.', obj({ asset_id: str }), { asset_id: null }, []),

  // Energy telemetry: numeric typing, null versus missing, empty collections, paged evidence.
  example('energy-numeric-id', 'energy', 'simple', 'Retain an integer ID as a number.', 'Read this meter.',
    'Read meter_id as an integer.', obj({ meter_id: int }), { meter_id: 101 }, [{ meter_id: 101 }]),
  example('energy-sensor-pairs', 'energy', 'intermediate', 'Preserve sensor and channel pairs in nested arrays.', 'Inspect every listed sensor channel.',
    'Read sensor_id with channel.', obj({ sensor_id: str, channel: int }), [[{ sensor_id: 'S1', channel: 0 }], [{ sensor_id: 'S2', channel: 2 }]], [{ sensor_id: 'S1', channel: 0 }, { sensor_id: 'S2', channel: 2 }]),
  example('energy-explicit-page', 'energy', 'complex', 'Use paging metadata to construct the next request without guessing.', 'Fetch the next readings page using exactly the continuation shown.',
    'Read meter_id at cursor. The continuation object contains complete next-call arguments.', obj({ meter_id: str, cursor: str }),
    { readings: [{ value: 4 }], continuation: { meter_id: 'M1', cursor: 'opaque:page-2' } }, [{ meter_id: 'M1', cursor: 'opaque:page-2' }]),
  example('energy-empty-list', 'energy', 'simple', 'An empty collection supplies no IDs to inspect.', 'Inspect any sensors in the returned list. If it is empty, do not invent a sensor.',
    'Read sensor_id.', obj({ sensor_id: str }), { sensors: [] }, []),
];
