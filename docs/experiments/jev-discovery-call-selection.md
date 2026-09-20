# Jev executable discovery calls: unsuccessful screen

Date: 2026-09-20. Decision: **do not adopt this version or extend it to write arguments**.

The experiment removed some argument-generation work, but did not establish a useful
end-to-end improvement. Exact source binding worked. Selecting the right tool for the
bound value did not always work. Required reads and writes were missed despite available
candidates, and many turns ended in runtime errors whose causes were not captured.

This document preserves the findings for future models. It does not add the experimental
implementation, tests, benchmark fixtures, or generated traces to the repository.

## Hypothesis and tested design

Jev might avoid an argument-model call by selecting a complete read call in its existing
controller request. A read could be worth inspecting even when its relevance to the
user's target was still unknown.

The experimental runtime:

- Enumerated distinct scalar values from full current and persisted tool results.
- Combined them with available read tools having one required scalar parameter and a
  supported object schema. It used no tool-name branches or domain field mappings.
- Kept exact source call IDs, JSON pointers, and source revisions for each prepared call.
- Supplied candidates alongside the retained task, constraints, missing-evidence blockers,
  and prior calls. Normal tool selection and argument resolution remained available.
- Assigned candidate IDs valid only for the current controller context. It checked the
  selected binding and schema again before using the normal prepared-input execution
  path, including policy, inspection, authorization, and repetition safeguards.
- Limited traversal to 10,000 nodes and candidates to 128 per tool. A capped enumeration
  reported partial coverage and offered no prepared calls for that tool.

Writes and unsupported schemas kept ordinary argument resolution. No public agent
option, required host candidate builder, or additional approval-model request was added.

## Evaluation scope

The candidate was based on Keeled commit
`800328a572cdaa986faafe0f63c97058f840c8fb`, with uncommitted experimental changes.
It ran airline tasks 0–9 once each: seed 300, concurrency 3, 300-second task timeout,
200 harness steps, and zero harness retries. Keeled used 60-second generation and
240-second turn timeouts.

Argument and response model: `deepseek/deepseek-v4.1-flash`, routed through Together then
Modal without other provider fallback. User simulator: `openrouter/openai/gpt-4.1`.
Jev used the SDK default alias; its resolved version was not recorded.

The checkout's existing task tracker remained enabled. Experiment 1's persistent progress
and exhausted-call state were absent, so the combined experiment was **not tested**.
There were no repeated held-out trials. This was a screening run, not an adoption study.

## Measured results

| Metric                                    | Candidate | Saved historical reference |
| ----------------------------------------- | --------: | -------------------------: |
| Task success                              |      8/10 |                       8/10 |
| Median task latency                       |    55.2 s |                     53.6 s |
| p90 task latency, nearest rank            |   121.8 s |                    106.4 s |
| Model calls                               |       220 |                        421 |
| Successful controller/authorization calls |       122 |                        418 |
| Jev input tokens                          | 2,426,473 |                  4,216,077 |
| Expected writes missed                    |       4/4 |                        3/4 |

The candidate executed **19 prepared calls**, each without argument generation, and made
45 ordinary argument-generation calls. All 19 prepared inputs matched their exact source
values. There were **zero observed source-binding errors**.

There were **three wrong-tool selections** among those 19 calls. The other 16 returned
reservation records. A 16/19 record-retrieval rate is not a labelled relevance score and
does not prove that the records advanced the user's goal.

No external state-changing calls executed: zero observed wrong writes, but four missed
expected writes across the two failed tasks. This is not evidence of safe write capability.

Recorded usage gives an uncached list-price estimate of **$0.388 total, or $0.0485 per
successful task**, excluding the simulator. The rates used on the report date were
[$0.042/M input tokens for Jev, with free output](https://docs.typesafe.ai/models), and
[$0.30/M input, $1.20/M output for DeepSeek on Together/Modal](https://openrouter.ai/deepseek/deepseek-v4.1-flash).
Cache discounts, failed requests without returned usage, and invoice reconciliation were
not available. This is an estimate, not measured billing.

The historical reference was `keeled_codex_simple_single_20260919/results.json`.
Its task definitions and recorded harness configuration matched, but Keeled runtime
revisions differed and historical provider/model and budget equality were not established.
The reference was not rerun. Lower aggregate calls and estimated cost therefore cannot be
attributed to this change. Latency did not improve in the observed comparison.

## What failed

### Source provenance did not establish tool compatibility

The enumerator could prove that a string occurred at a particular source pointer. A
string schema could not prove that it was the kind of identifier the selected tool needed.
The candidate set therefore included schema-valid but semantically wrong tool/value pairs.

Jev selected a flight identifier and two reservation identifiers as inputs to the user
lookup. All three returned “not found.” The runtime copied the intended source values
correctly; these were selection errors, not stale references or incorrect copying.

This distinction matters: a value may be worth inspecting before its relevance is known,
but it still needs a defensible relationship to the input contract of the tool used to
inspect it. “Observed string” is too weak a substitute for that relationship.

### Available candidates were not reliably selected

Case 7's uninspected reservation was offered through the correct tool in **nine**
successful controller contexts. Case 8's matching reservation was offered through the
correct tool in **seven** contexts. Neither was inspected through that tool.

In case 8, the matching reservation identifier was instead sent to the user lookup.
The agent later described the reservation as unavailable without having made the correct
reservation lookup. The task ended without the requested booking.

These specific misses were not caused by traversal omitting the identifiers. Increasing
the candidate cap alone would not address the observed failures. The run does not prove
which alternative prompt or decision structure would fix selection.

### Error handling and telemetry limited the conclusions

The trajectories contained **38 turns ending in `error`**, including 20 in a task that
still earned a passing benchmark reward. The bridge did not persist the originating
runtime exceptions. At least one generation trace recorded an unparseable model response;
the other error causes were not established.

Candidate growth, context limits, and provider failures are possible explanations, not
proven causes. Do not cite this run as proof that any one of them caused the errors.
The passing score also does not erase the observed runtime failures.

### Avoiding arguments did not establish end-to-end value

The narrow mechanism saved 19 argument-generation invocations. That did not ensure useful
reads, preserve all requested work, or improve observed latency. Cases 7 and 8 missed an
upgrade, two cancellations, and a booking. Equal aggregate success against an older run
was not enough to accept the change.

## Coverage and validation limits

Of 121 successful controller selections, 98 contexts contained prepared candidates.
There were 228 tool/context pairs marked complete and 1,707 marked unsupported. Unsupported
included writes, multi-argument tools, and tools suspended after ordinary resolution
failures. No live context reported partial coverage; synthetic tests covered both limits.

“Complete” meant all distinct schema-valid scalar bindings within the supported observed
result scope were enumerated. It did not mean semantic compatibility, target discovery,
or complete support for the tool catalog. Coverage of requests that failed before a
controller response was not captured by these counts.

The experimental code passed 101 tests plus typecheck, lint, and formatting. Tests covered
renamed tools across domains, unchecked and misleading values, multiple possible IDs,
stale/unknown IDs, deep collections, escaped pointers, overflow, prior-turn sources,
raw-schema bounds, and execution inspection. A mocked Jev test verified use of one
existing controller request; it did not measure live selection accuracy.

A separate integration finding: the installed AI SDK's raw JSON-schema wrapper did not
validate values unless given a validator. The experiment used a narrow explicit validator
and declined unsupported schema features. Future attempts must verify runtime validation
rather than infer it from a schema object being present.

## Guidance for future attempts

1. Keep source binding, tool/input compatibility, and target relevance separate. A record
   need not already match the target to be inspected. That does not make it valid input
   for every tool that accepts the same scalar type.
2. Do not fix these examples with airline field mappings, tool-name branches, identifier
   patterns, or host candidate builders. Keeled must consume contracts and evidence
   through general interfaces. Any new mechanism needs unrelated and renamed fixtures.
3. Keep normal argument resolution available for unsupported, partial, ambiguous, or
   unsuitable candidate sets. Never present a capped candidate list as complete.
4. Capture failed controller requests and originating runtime exceptions, not just
   successful decisions. Record model versions, budgets, candidate coverage, and exact
   selections before making causal or cost claims.
5. If persistent progress is later combined with discovery, test it separately and
   together. Do not assume this run measured exhausted-call exclusion.
6. Require repeated held-out trials with matching models and budgets. Measure total
   argument work, binding errors, wrong-tool selections, wrong and missed writes, task
   success, cost per success, and median/p90 latency. Saved traces may serve as a reference
   only when comparability is established.
7. Do not expand to write arguments unless the read experiment reduces end-to-end cost
   or latency without reducing success. More valid bindings alone are insufficient.

## Evidence provenance

These figures were computed from the locally retained, ignored
`reviews/discovery-calls/run/results.json`, with `summary.json`, `manifest.json`,
`run.log`, and `summarize.py` in the same experiment directory. Those artifacts and the
experimental implementation are not included in this documentation-only change. A fresh
checkout can read the findings but cannot independently recompute them from this PR.
The historical reference remains in the separate Tau checkout. This report must not be
mistaken for measurements of the repository's current main branch.
