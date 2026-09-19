# Argument and field-matching microbench

Fifty synthetic cases exercise existing production candidate and resolver code, without
Jev selection, task tracking, response generation, or a simulated user. Fixtures cover 14 domains and three difficulty levels: 15 simple, 20 intermediate,
and 15 complex cases. No benchmark domain mappings are added.

```sh
# Offline candidate coverage; no credentials or model calls.
bun run microbench --mode candidates

# Live argument resolution; uses KEELED_MODEL and OPENROUTER_API_KEY.
bun run microbench --mode resolver

# Both layers, repeated sampling, or a focused subset.
bun run microbench --mode all --trials 3
bun run microbench --mode resolver --case collection-ids,root-ref
bun run microbench --mode resolver --domain library,devops --difficulty complex
bun run microbench --help
```

The live layer uses the configured non-reasoning argument model and the actual bridge
resolver inside the core execution loop. A scripted controller selects the tested tool
once per expected record; it never supplies arguments. Tool execution is synthetic and
only records the input and returns an acknowledgement. Expected inputs are grader-only.
For scoped or ambiguous requests, `candidateExpected` may contain all safely grounded
possibilities while `expected` contains only the calls the user actually requested. This
prevents candidate coverage from being confused with semantic selection. Both are grader-only.

The two layers are evaluated independently: candidate coverage is not end-to-end quality,
and the resolver layer does not test whether Jev would select a ready candidate.

A pass requires complete, unique, schema-valid inputs matching the allowed records.
Input order does not matter. Extra calls, duplicates, crossed record fields, invalid
arguments, and partial enumeration fail. Negative cases require no calls; the live layer
also requires a missing-evidence refusal. Generation errors are failures, not refusals.
The grader validates root schema references independently of the runtime.

Cases include exact fields, collection IDs, different domain vocabulary, a described alias,
ambiguous IDs, an incomplete record beside a complete one, nested records, root `$ref`,
a required summary behind `$ref`, and a missing required ID.

Results contain actual and expected arguments, blockers, purpose-tagged traces, usage,
latency, trial number, model/provider settings, and Git commit/dirty state. They are saved
under ignored `reviews/microbench/` by default. Exit status is 1 when any case fails;
known limitations are deliberately visible. Use multiple trials to assess model variability.

This is a diagnostic benchmark, not a new implementation. Do not tune runtime code to
these IDs or fixtures. General fixes should transfer across schemas and renamed tools.


## Expanded coverage

See the [50-case catalog](CATALOG.md) for domains, difficulty, and each failure mechanism.
Domains include documents, inventory, logistics, support, general records, library,
retail, DevOps, calendar, accounting, education, clinic administration, media, and energy.
The clinic cases concern record identifiers only, not medical decisions.

Simple cases establish copying, numeric typing, booleans, null rejection, Unicode,
and user-provided arguments. Intermediate cases cover enumeration, aliasing, optional
fields, batching, missing units, enums, duplicate IDs, and ambiguous requests. Complex
cases cover explicit joins, parent scope, nested references, allOf/oneOf schemas,
conflicting observations, continuation cursors, and incomplete records.

The report includes separate domain and difficulty totals for each layer. These are
single snapshots with scripted tool selection, not full planning, authentication, or
conversation-quality tests. An expanded suite score is not directly comparable to the
original 10-case score; use `--case` for a matched subset and `--trials` for repeatability.
