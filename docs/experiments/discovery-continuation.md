# Bounded discovery continuation: first screen

Date: 2026-09-20. Decision: **keep experimental and opt-in; do not adopt as default**.

The final candidate passed **9/10 airline tasks**, versus **8/10** in the saved
historical reference. It used fewer generations and a lower estimated cost per
success, but median latency was slightly higher. It issued two semantically wrong
read calls and missed two expected writes in the failed task. This is one development
screen, not a causal improvement claim or held-out adoption evidence.

Follow-up: [full 50-task run](discovery-continuation-full50.md) passed **34/50 (68%)**
with unchanged runtime code. Keep this initial screen separate.

## API and behavior

```ts
const agent = createAgent({
  instructions,
  model,
  argumentsModel, // Optional. Also used for discovery planning when supplied.
  controller: jev(),
  tools,
  discovery: { enabled: true, maxCalls: 8 },
});
```

An LLM establishes a short relationship between an observed collection and a read
tool. Code copies its references and advances through the collection. Jev evaluates
one returned record against the objective and constraints. Every prepared read uses
the normal executor, availability, schema validation, risk policy, inspection,
authorization, and confirmation path. The continuation never executes a tool itself
or grants permission to write.

The first implementation supports one required scalar input, including scalars bound
through a field path inside each collection item. Source selection is constrained to
the IDs of offered collections, and tool selection to available read tools. It does
not add domain adapters, tool-name branches, host callbacks, or application field
mappings. Input schemas and tool descriptions remain the ordinary application API.

Collections must be complete arrays of at most 64 elements, discovered within a
six-level, 10,000-node traversal. Active source references are checked against the
latest observed result for the same call. This is observed-state freshness, not a
promise that external data has not changed. Unsupported schemas, transformed inputs,
or any previously attempted candidate return to ordinary reasoning. The last rule
is conservative: this version does not merge old reads with remaining candidates.

`maxCalls` caps prepared reads and planning attempts per turn; ordinary step and time
limits still apply. `any` may stop at a match. `unique` and `all` inspect the collection
unless an error, uncertainty, changed availability, or budget stops them. Multiple
matches remain ambiguous. A new user turn gets a new planner allowance. Negative
planning decisions are not cached across user turns.

`data-discovery` records preserve the objective, source, coverage, match references,
uncertain references, and termination reason. These are judgments, not task completion,
write receipts, or global coverage. Active procedures are turn-local. Their audit
records remain in the persisted messages. Custom controllers must implement the
optional `evaluateDiscovery` method when discovery is enabled.

## Final evaluation

Run:

```bash
KEELED_DISCOVERY=1 KEELED_JEV_MODEL=jev-1.13.0 KEELED_BRIDGE_PORT=8798 \
  bun --env-file=/Users/caseycollins/projects/tau2-bench/.env run tau3:first airline 10 \
  --seed 300 --max-concurrency 3 --max-steps 200 --timeout 300 --max-retries 0 \
  --save-to keeled_discovery_continuation_enum_first10_20260920
```

- Keeled base: `73b89e90a1375744a3bc5c362cbe8da6c7ed3d68`.
- Branch: `codex/discovery-continuation`, with the experiment as local changes.
- Runtime source fingerprint: `9704d4045fb0f8448bfcd1dcba1e7ce5a72ace129d20b388b5cd2020b727dec5` (SHA-256 over the sorted
  per-file SHA-256 map of TypeScript sources in core, Jev, and the bridge).
- Tau commit recorded in results: `b7ea9074c1cba482b30687fecdb5c8425fd6f619`.
- Tasks 0–9, one trial, seed 300, concurrency 3, 200 steps, 300-second task timeout,
  zero retries. Runtime generation/turn timeouts: 60/240 seconds.
- Agent: `deepseek/deepseek-v4.1-flash`, configured routing Together then Modal.
  Discovery planning uses the existing arguments model with reasoning disabled.
  Other model settings are unchanged. Resolved upstream provider per generation
  was not captured.
- Jev explicitly pinned to `jev-1.13.0`; record-check responses confirm that version.
- User simulator: `openrouter/openai/gpt-4.1`.

| Metric                                         | Saved historical reference | Final candidate |
| ---------------------------------------------- | -------------------------: | --------------: |
| Task success                                   |                       8/10 |            9/10 |
| Timeouts                                       |                          0 |               0 |
| Median task latency                            |                     53.6 s |          58.9 s |
| p90 task latency, nearest rank                 |                    106.4 s |         108.6 s |
| Recorded generations                           |                        421 |             333 |
| Recorded failed generations                    |                          0 |               2 |
| Global controller selection attempts           |                        401 |             172 |
| External tool calls                            |                         39 |              49 |
| State-changing attempts                        |                          1 |               2 |
| Successful writes matching reference arguments |                          1 |               2 |
| Missed reference writes                        |                        3/4 |             2/4 |
| Duplicate write attempts                       |                          0 |               0 |
| Observed writes outside reference actions      |                          0 |               0 |
| Estimated agent + Jev cost per success         |                    $0.0985 |         $0.0693 |

The reference is `keeled_codex_simple_single_20260919/results.json`. Models by alias, task IDs, seed,
and benchmark budget match, but Keeled source, validation, prompts, run time, and
provider conditions differ. The reference did not record a resolved Jev version.
It is a historical comparison, not a paired control. The baseline was not rerun.

Costs use the same normalized rates as the prior joint-generation report:
$0.30/$1.20 per million agent input/output tokens and $0.042 per million Jev input
tokens. These are comparative estimates, not verified current invoice amounts.
Final candidate agent + Jev estimate: $0.6240; simulator: $0.1711. Including the
simulator, estimated cost per success is $0.0883 versus $0.1174. Failed generations
can lack token usage, so costs can be understated.

## What discovery actually did

- **81 planning generations** proposed seven accepted continuations.
- **18 prepared read attempts** avoided per-read argument generation and global
  tool selection. Sixteen returned records and received a Jev check; two failed.
- All 18 inputs contained values present in earlier tool results. This verifies
  observed-value copying, not semantic compatibility with the selected tool.
- Two procedures finished their collection; five returned to ordinary reasoning
  because of uncertainty or a failed read.
- Planning took 60.4 seconds in aggregate across tasks; the 16 Jev record checks
  took 3.0 seconds. These are summed stage times, not end-to-end wall time.
- Recorded dispositions: 38 planner declines, 19 proposals rejected because a
  candidate was already attempted, and 17 rejected non-scalar bindings.

Case 1 demonstrates the intended behavior: a single procedure inspected five known
references and found the requested route. Case 8 also inspected all five references,
then the ordinary controller completed the expected booking with exactly matching
arguments and no duplicate attempt.

There are important limits. Case 8's generated objective was an open-ended request
for flight details, not a proper matching predicate. Jev produced no positive match;
the collected records still helped the ordinary controller. This supports the value
of deterministic iteration, but does not establish Jev's incremental value.

Two wrong-tool bindings survived scalar/schema checks:

- Case 5 passed flight reference `HAT045` to `get_reservation_details`.
- Case 7 passed reservation reference `7WPL39` to `get_user_details`.

Both calls returned not-found errors and stopped their continuations. No wrong write
was observed. The binding relationship remains an LLM inference; source provenance
and a valid input schema cannot prove that it selected the correct kind of entity.
Some generated objectives also required ordering or unavailable status evidence,
despite the planner instruction to keep them direct. The runtime preserved Jev's
uncertainty and returned to ordinary reasoning.

## Failed case and other errors

Case 7 cancelled `59XX6W`, matching one expected write. It did not upgrade or cancel
`XEHM4B` and did not communicate the required $1,628 total. Later responses repeatedly
requested confirmation for a human transfer after the user had confirmed it.
Discovery does not fix that policy/confirmation behavior. The case ended normally
with a zero reward, not a timeout.

Case 4 had two task-extraction parse failures but eventually passed. All 21 expected
read action checks passed across the final ten cases; two of four expected write
checks passed. Benchmark success alone is not a complete measure of requested work.

## Preserved setup failures

Two interrupted screens exposed implementation bugs before the final screen:

1. `keeled_discovery_continuation_first10_20260920`: **3/7 saved tasks passed**, three saved timeouts. The bridge omitted
   the core agent's arguments-model option, so discovery used the full reasoning
   model. Forty-eight recorded plans spent roughly 1,073 aggregate seconds and
   over 200,000 reasoning tokens. The run was interrupted with three tasks in
   progress. Saved-task estimated agent + Jev cost was $0.6174; incomplete work
   is not fully accounted for.
2. `keeled_discovery_continuation_fixed_first10_20260920`: **4/4 saved tasks passed**, but diagnostics showed repeated source
   contract errors. The unconstrained `source` string often held a tool name or
   field name instead of an offered collection ID. The run was interrupted after
   identifying this defect. The final implementation constrains source/tool
   choices and documents field meanings. Saved-task estimated cost was $0.2192;
   active tasks and unsaved work are not fully accounted for.

These partial samples are not full ten-task results, not repeats of the final
configuration, and must not be pooled with the final score. Both raw result files
remain in the Tau checkout.

## Validation and limits

`bun run check` passed: lint, formatting, TypeScript, and **126 tests**. Tests cover
renamed document/device catalogs, direct and nested value binding, write exclusion,
invalid/transformed input, policy denial, failed reads/checks, ambiguity, budgets,
changed availability, disabled behavior, immutable audit snapshots, the actual
emitted source enum, and the bridge's model forwarding.

A live synthetic document example used a prepared index lookup, then the real LLM
planner and Jev checks. It inspected three documents, identified one matching record,
and completed in about 2.5 seconds using one planning generation and one response
generation. It is a component smoke test, not a benchmark comparison or proof of
open-ended initial tool selection.

Keep discovery optional. The final screen supports further testing of deterministic
iteration, but 81 plans for 18 prepared reads is substantial overhead. Generated
binding relationships and objectives still need better quality before adoption.
No domain-specific fix was added. There was no retail or held-out multi-catalog live
benchmark and no repeated final trial.

Raw results live under `/Users/caseycollins/projects/tau2-bench/data/simulations/`.
The durable compact measurements are in
[discovery-continuation-metrics.json](discovery-continuation-metrics.json). Raw traces
and temporary source snapshots are local provenance, not portable dependencies.
