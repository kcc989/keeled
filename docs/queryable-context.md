# Queryable facts and decision context

Ordinary `createAgent({ instructions, tools, controller: jev(), model })` setup now
creates a session-scoped fact catalog. No context flag, domain reducer, ranking
adapter, or new database is required.

## Consumer interface

Managed tool, task-tracker, and response callbacks receive `context.store`:

```ts
const result = await context.store.query('Which supplied records and constraints support the proposed change?', {
  abortSignal,
});
```

The sole store method is `query`. Results contain immutable `facts`, exact `sources`,
a catalog `revision`, and `coverage`. A known fact ID is an exact query and requires
no model call. Other questions use a lexical index to construct up to 64 candidates,
then independent Jev relevance and contradiction judgments. Built-in consumers rank
observations only; instructions, user text, and contracts are supplied separately and
are not duplicated as semantic candidates. Public queries can still search all source roles. Multiple candidates or
none can be retained. Unknown references, missing judgments, malformed probabilities,
missing source versions, and budget overflow reject the query.

Built-in consumers use complete exact observations without a semantic call when all
current tool sources are fully indexed and their combined JSON content fits 12,000
characters. This is complete local scope, not a claim of external completeness.
Larger scopes use the semantic path. Public natural-language queries retain their
question-specific semantic behavior at every size.

An explicit signal can shorten the enclosing deadline. It cannot extend it. Failed
queries are never cached. Successful unchanged queries share a run-local cache.
New sources, source versions, lifecycle revisions, or changed question text invalidate
it. The catalog and accepted facts persist; the inference cache does not persist
between agent runs. Queries pin a source snapshot before asynchronous inference.

`coverage.complete` describes deterministic examination of the reported stored
scope. Semantic filtering always reports incomplete coverage, even if every candidate
was judged relevant. It never claims complete external knowledge. An empty successful
result means no match, not a failure or proof that no fact exists.

## Storage and ingestion

The version-5 reducer accepts versioned `data-catalog` and validated `data-knowledge`
message parts alongside the existing operational events. Catalog sources retain
original content, role, authority, source order, source version, structural locations,
processing status, and pending indexing regions. Source versions are internal content
fingerprints, not invented external timestamps or entity revisions. Supplied metadata
inside records remains unchanged.

Each structured result retains a complete root record and independently addressable
container/child records. JSON pointers escape `~` and `/`. Strings become exact
paragraph passages; text offsets are UTF-16 code units. Source identities follow the
message part or actual tool call and its version. Fields such as `id` and `name` do
not cause entity merges. A changed version of the same source supersedes its older
facts; distinct calls remain separate observations even when their values conflict.

Indexing processes at most 2,048 structural visits per source and 128 sources per run.
Unprocessed regions and source placeholders persist. Later runs continue indexing
those sources through the same path. Depth beyond 64 remains unindexed and visible
as incomplete coverage. The original source remains available. Text with many
paragraphs retains the remaining text as one complete passage rather than dropping it.
These are indexing-work bounds, not a bound on the size of supplied source content.

Task extraction can add exact quoted user restrictions as derived projections.
The reducer accepts copied source values, valid source spans, and current dependencies;
it rejects invented extracted content. Explicit quoted task withdrawals create lifecycle
updates. User corrections cannot change tool observations or instructions. Invalidating
a dependency marks its derived facts superseded. There is no free-form generative
entity extractor or inferred domain upsert rule in this release. Structural ingestion
and basic text retention require no inference.

## Decision packets

Core builds the shared packet used by action selection, default arguments, permission
verification, task completion, and responses. Source-quoted task updates use a
narrow packet containing the latest user message, existing task contract, and
preceding assistant message for conversational references. They do not need tool
observations to identify what the user just requested. Tau calls the same argument
resolver and packet builder; it keeps ready/missing results, risk-based models, external
call promises, confirmation, and the normal execution checks.

`modelTaskTracker` accepts separate `extractionModel` and `verificationModel`
settings. An omitted setting uses the agent model. The bridge currently routes both
to its structured read model for evaluation; write arguments and permission checks
retain their existing model routes. Completion references still pass the same runtime
checks for successful calls and required writes.

Original current instructions, retained user messages, assistant proposals, task state,
inspections, blockers, and uncertain operations are mandatory. Assistant proposals
carry proposal authority; tool results carry observation authority. Neither grants
permission or creates successful execution. Full operational history remains available
to deterministic validation and completion checks.

A bounded Jev question flags exhaustive comparison scope. Selected tool sources expand
in full for that scope, or for text-source context, when their combined content fits
80,000 characters.
This preserves nearby text exceptions and complete comparison sets. Larger scopes remain
explicitly incomplete. The consumer must obtain sufficient scope or explain the evidence
limit; the catalog does not add a planner, arithmetic engine, or special argument binder.

The judgment candidate budget is 120,000 JSON characters, the returned query budget is
160,000, and the assembled decision budget is 240,000. These are conservative transport
bounds, not model-specific token-window estimates. Mandatory content is not silently
clipped to fit. On judgment failure, built-in consumers try a full-source packet within
the same final bound and label the fallback. If it cannot fit, execution stops with an
explicit context budget error. Custom store callers receive the original query error.

Custom controllers should implement `Controller.judgeFacts`. Inputs contain actual
candidate envelopes and source labels; outputs contain one validated relevance and
contradiction probability per candidate. TypeSafe stays in `@keeled/jev`. The optional
joint controller accepts this same judgment method and remains experimental.

## Diagnostics and measurement limits

`onGeneration` includes `context_query` traces with cache hits, catalog revision,
selection counts and references, coverage, token usage, elapsed time, and failure details.
Runtime errors are also exposed as `runtime_error` traces. Query inference is charged
to controller usage. Failed requests count as calls. Known usage from failed structured generation is
retained; tokens unknown after a provider failure are not invented. Callback exceptions do not alter query behavior.

The design does not establish a cost, latency, or accuracy improvement. Full-source
expansion and mandatory user/proposal history can be expensive. Large or ambiguous
retrieval scopes can exceed the current bounds. Labeled recall, calibrated relevance
thresholds, cost per success, and broad held-out evaluation remain measurement work.
See the [implementation validation report](queryable-context-validation.md).

Held confirmations require explicit controller selection on subsequent turns.
Jev can choose an exact stored input when the user confirms it unchanged, or use
ordinary argument resolution for a correction. Every selected call still passes
normal validation and authorization. The runtime does not replay all pending
calls automatically. Custom controllers must select held calls explicitly.
