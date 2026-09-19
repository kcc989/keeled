# Microbenchmark case catalog

58 synthetic cases across 18 domains: 15 simple, 20 intermediate, 23 complex.
Expected calls are grader-only; zero means the resolver must decline for missing evidence.
Candidate coverage may use a separate expected set for ambiguous or scoped requests.

| Case | Domain | Difficulty | Mechanism | Resolver expectation |
| --- | --- | --- | --- | --- |
| exact-records | documents | simple | Copy complete related fields without crossing records. | 2 call(s) |
| collection-ids | documents | intermediate | Enumerate known IDs without asking the user to choose. | 3 call(s) |
| renamed-collection | inventory | intermediate | The same enumeration with a different vocabulary. | 2 call(s) |
| described-alias | logistics | intermediate | Use a relationship stated in the tool contract. | 1 call(s) |
| ambiguous-id | records | intermediate | Decline instead of inventing an identifier relationship. | Decline |
| missing-related-field | documents | complex | Do not combine unrelated IDs and revisions. | 1 call(s) |
| nested-records | inventory | complex | Preserve record relationships inside nested collections. | 2 call(s) |
| root-ref | documents | complex | Resolve required fields through a root schema reference. | 1 call(s) |
| required-summary | support | complex | Supply a required summary rather than empty arguments. | 1 call(s) |
| missing-required | records | simple | Decline when a required argument has no source. | Decline |
| library-isbn | library | simple | Preserve leading zeros in identifiers. | 1 call(s) |
| library-loans | library | intermediate | Enumerate a named collection of scalar IDs. | 3 call(s) |
| library-keyed-copies | library | complex | Use object keys as IDs while preserving associated branches. | 2 call(s) |
| library-ambiguous-title | library | intermediate | Decline when a title identifies multiple editions. | Decline |
| retail-single-order | retail | simple | Ignore unrelated fields. | 1 call(s) |
| retail-batch-orders | retail | intermediate | Pass a whole ID array when the tool supports batching. | 1 call(s) |
| retail-line-items | retail | complex | Construct nested input from a declared outer relationship. | 2 call(s) |
| retail-unknown-state | retail | intermediate | Do not invent a mapping to a restricted enum. | Decline |
| logistics-tracking | logistics | simple | Copy a literal ID. | 1 call(s) |
| logistics-related-dates | logistics | intermediate | Keep each checkpoint ID attached to its own date. | 2 call(s) |
| logistics-explicit-join | logistics | complex | Join records only through a stated foreign key. | 2 call(s) |
| logistics-missing-unit | logistics | intermediate | A quantity without units is insufficient. | Decline |
| devops-false-flag | devops | simple | Preserve false rather than treating it as missing. | 1 call(s) |
| devops-composite-key | devops | intermediate | The same name in different namespaces denotes separate resources. | 2 call(s) |
| devops-nested-ref | devops | complex | Validate an input object whose nested property uses a schema reference. | 1 call(s) |
| devops-conflicting-version | devops | complex | Decline a current-version request when equally authoritative observations conflict. | Decline |
| calendar-literal-timezone | calendar | simple | Preserve the supplied timezone string. | 1 call(s) |
| calendar-explicit-null | calendar | intermediate | Preserve an explicit null accepted by the contract. | 1 call(s) |
| calendar-owner-scope | calendar | complex | Select only records within the requested owner scope. | 2 call(s) |
| calendar-unknown-timezone | calendar | intermediate | Do not infer a timezone from an unqualified local time. | Decline |
| accounting-zero-offset | accounting | simple | Zero is a valid value. | 1 call(s) |
| accounting-decimal-string | accounting | intermediate | Preserve exact decimal strings without rounding. | 1 call(s) |
| accounting-allof | accounting | complex | Resolve required fields combined through allOf. | 1 call(s) |
| accounting-wrong-id-kind | accounting | intermediate | Do not substitute an account ID for an invoice ID. | Decline |
| education-request-only | education | simple | Use an argument stated by the user rather than returned by a tool. | 1 call(s) |
| education-enum | education | simple | Copy an enum value exactly. | 1 call(s) |
| education-parent-scope | education | complex | Inherit an explicitly defined parent field without crossing groups. | 3 call(s) |
| education-deduplicate | education | intermediate | Inspect each unique ID once even if the source repeats it. | 2 call(s) |
| clinic-appointment | clinic-admin | simple | Copy an appointment identifier. | 1 call(s) |
| clinic-optional-field | clinic-admin | intermediate | Omit an unknown optional field instead of fabricating it. | 1 call(s) |
| clinic-ref-array | clinic-admin | complex | Preserve a batch of nested referenced objects. | 1 call(s) |
| clinic-missing-identity | clinic-admin | intermediate | A display name is not an established record identifier. | Decline |
| media-unicode | media | simple | Preserve Unicode text without translation. | 1 call(s) |
| media-nested-filter | media | intermediate | Copy a structured filter intact. | 1 call(s) |
| media-discriminated-ref | media | complex | Choose the schema branch matching a supplied discriminator. | 1 call(s) |
| media-null-id | media | simple | Null does not satisfy a required string ID. | Decline |
| energy-numeric-id | energy | simple | Retain an integer ID as a number. | 1 call(s) |
| energy-sensor-pairs | energy | intermediate | Preserve sensor and channel pairs in nested arrays. | 2 call(s) |
| energy-explicit-page | energy | complex | Use paging metadata to construct the next request without guessing. | 1 call(s) |
| energy-empty-list | energy | simple | An empty collection supplies no IDs to inspect. | Decline |
| semantic-trip-flight | aviation | complex | Map a domain synonym while rejecting a nearby transport distractor. | 2 call(s) |
| semantic-dispatch-shipment | fulfillment | complex | Relate operational vocabulary without matching identifier names. | 2 call(s) |
| semantic-roster-employee | workplace | complex | Select the intended people collection from semantically related distractors. | 2 call(s) |
| semantic-case-ticket | support | complex | Resolve business terminology rather than a spelling relationship. | 2 call(s) |
| semantic-locator-reservation | travel | complex | Use an industry synonym with no shared target-field token. | 2 call(s) |
| semantic-monitor-sensor | energy | complex | Distinguish semantically related device roles from a distractor collection. | 2 call(s) |
| semantic-reel-asset | media | complex | Interpret a content-system concept instead of matching field morphology. | 2 call(s) |
| semantic-stock-unit-sku | inventory | complex | Map an explained abbreviation while ignoring another valid identifier family. | 2 call(s) |
