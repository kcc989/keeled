# Reducing Jev input tokens

Date: 2026-09-21. Status: design options; not implemented.

## Problem

Keeled sends substantial input to Jev. The latest ten-case screen used 2,914,754
Jev input tokens across 207 calls, or about 14,100 tokens per call. The earlier
full 50-task run used 11,866,101 Jev input tokens.

The current context flow can pay twice for the same evidence. A semantic context
query sends candidate facts to Jev. The selected evidence is then sent again to a
later controller or generation request. When a fact-query payload is split into
several requests, each batch also repeats query text, source metadata, question
instructions, and the exhaustive-scope judgment.

Splitting is useful error recovery, but it is not an efficiency improvement. In
the measured tasks 10–19 screen, splitting removed 15 context-query failures while
Jev input increased from 2,830,336 to 8,921,262 tokens. Trajectories also changed,
so this comparison does not prove that splitting alone caused the increase.

## Recommended changes

### 1. Merge relevance and contradiction judgments

Each candidate currently receives separate `relevant_N` and `conflict_N`
judgments. Selection later retains a candidate when either probability crosses
the same threshold. Replace them with one `retain_N` judgment that asks whether the
candidate supplies supporting, governing, or conflicting evidence needed for the
query.

This removes almost half of the repeated candidate-question text. It preserves the
current selection result unless another consumer needs separate relevance and
contradiction probabilities. No current selection consumer does.

### 2. Judge exhaustive scope once per query

Every split batch repeats the same `exhaustive` judgment. Evaluate that question
once for the query, then send only candidate-retention questions in split batches.
Keep an unknown result conservative.

This change should reduce repeated input while preserving the current rule that a
complete comparison, total, extremum, or no-match claim needs complete source scope.

### 3. Cache judgments per candidate version

The current cache is based on the complete catalog revision, scope, and question.
An unrelated catalog change can therefore invalidate judgments for unchanged facts.

Cache candidate results by normalized query meaning, fact ID, and fact version.
When the catalog changes, ask Jev only about new or changed facts. Keep query-level
properties, such as exhaustive scope, in a separate cache entry. Cache only
successful judgments and retain exact source revision checks before using them.

### 4. Build purpose-specific Jev state

The shared decision packet contains more information than every judgment needs.
Construct a narrow typed state for each purpose:

- Action selection needs the current request, retained goals and constraints,
  available actions, blockers, pending confirmations, and compact outcomes.
- Authorization needs the exact pending action, applicable instructions, retained
  constraints, verified facts, and evidence for the relevant conditions.
- Argument binding needs the selected tool schema and evidence that can supply its
  fields.
- Completion verification needs requested outcomes and successful call references.
- Response generation needs supported outcomes, blockers, and evidence required for
  the final answer.

For example, authorization does not need unrelated tool contracts or complete call
history. Keep deterministic policy, confirmation, validation, and revision checks
in code.

### 5. Reuse evidence within an execution cycle

Keeled can query context separately for action selection, argument binding,
authorization, completion verification, and response generation. Build one
revision-bound evidence view for the cycle and reuse it when the later consumer's
question is already covered. Issue another semantic query only when the action or
consumer introduces a materially different evidence need.

Do not reuse a view after its source revision changes.

### 6. Judge compact candidates and hydrate selected evidence

Jev needs enough candidate content to decide whether to retain an item. It does not
always need complete provenance and source content in the judgment request. Send a
bounded candidate projection, return stable fact IDs, and hydrate the selected
facts and exact provenance from the catalog in code.

This option carries the greatest recall risk. Earlier narrower-relevance experiments
lost accuracy. Validate it with labeled retrieval fixtures before using it in a
full-agent run. Do not truncate values that distinguish otherwise similar records.

## Changes to avoid

- Do not treat request splitting as token optimization. It repeats fixed request
  content and is only a fallback for provider limits.
- Do not add benchmark fields, tool names, business vocabulary, or expected
  trajectories to retrieval logic.
- Do not discard old history through an arbitrary count limit. Relevant cross-turn
  evidence can be older than the limit.
- Do not remove exact arguments, provenance, authorization state, or revision checks
  to reduce payload size.

## Proposed evaluation order

Implement and evaluate the first three changes together because they remove
structural duplication without changing the catalog model:

1. Run deterministic tests for renamed tools, supporting evidence, conflicting
   evidence, exhaustive queries, absent targets, cache invalidation, and source
   revision changes.
2. Replay fixed saved inputs and compare selected fact IDs and exhaustive-scope
   judgments before and after the change.
3. Record Jev input tokens by purpose, candidate count, serialized request bytes,
   question count, split count, and candidate-cache hits.
4. Require no material retrieval-recall loss before a live agent screen.
5. Run the complete agreed screen before making an accuracy, cost, or latency claim.

The first target should be lower Jev input with equivalent selected evidence and
scope decisions. A benchmark score alone cannot show that the context mechanism
improved.
