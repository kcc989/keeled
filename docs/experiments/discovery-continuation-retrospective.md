# Bounded discovery continuation: complete experiment record

Date: 2026-09-20. Final decision: **rejected for merge; implementation removed**.

The experiment tested whether Keeled could replace repeated global decisions and
argument generation with a short read-only procedure: an LLM identifies a collection
and a compatible lookup tool, code copies references and advances through it, and
Jev evaluates each returned record. The final implementation passed 9/10 tasks in a
development screen, then 34/50 (68%) on the full airline set. The user chose not to
merge it. This document preserves the proposal, implementation, setup failures,
measurements, limitations, and removal decision in one place.

## Archive and final repository state

The complete candidate, tests, and original reports are archived in commit
`f4d120b963c638a3b20ed792d9cc58ec74199312` on `codex/discovery-continuation`.
Its parent is `73b89e90a1375744a3bc5c362cbe8da6c7ed3d68`.
The work was isolated in
`/Users/caseycollins/.codex/worktrees/discovery-continuation/keeled`.

After the archive commit, the implementation, experiment-specific tests, bridge
changes, and public usage documentation were restored to the parent version.
The new discovery module and its tests were removed. The final diff from that
parent contains only experiment documentation and compact measurements.
No code from this experiment is supported by the final branch state.
The archived commit is for inspection or reproduction, not an adoption recommendation.

The removal includes the arguments-model forwarding fix and Jev model environment
option introduced during this work. They were not silently retained as independent
production fixes. If reconsidered, they need their own scoped change and evaluation.
No credentials were committed. Credentials stayed in the existing Tau environment
file; the user authorized live calls to OpenRouter and Jev.

## Original proposal and tested scope

The supplied analysis argued that Jev should make narrow evidence judgments rather
than repeatedly rediscover a workflow. The proposed division was:

| Responsibility                                                             | Owner                        |
| -------------------------------------------------------------------------- | ---------------------------- |
| Infer a short dependency and tool relationship                             | LLM                          |
| Copy observed values, iterate, validate, stop on limits                    | Code                         |
| Judge a record against a direct objective and constraints                  | Jev                          |
| Enforce policy, authorization, confirmation, execution, and write outcomes | Existing runtime             |
| Explain the outcome                                                        | LLM using execution evidence |

The broader analysis also proposed evidence-specific completion checks, selective
strong-model escalation, narrower failed-proposal tracking, and improved operation
identity. Those were not implemented here. This experiment tested a bounded
read/discovery continuation, not a general workflow engine or a new write executor.

The experimental API was:

```ts
createAgent({
  instructions,
  model,
  argumentsModel,
  controller: jev(),
  tools,
  discovery: { enabled: true, maxCalls: 8 },
});
```

This is historical API documentation. The option is absent after removal.
Applications used ordinary tool descriptions and schemas; there were no airline
adapters, tool-name branches, task-specific shortcuts, or extra host callbacks.

## What was implemented

A turn-local `DiscoveryRun` gathered complete observed arrays of at most 64 items,
within a six-level, 10,000-node traversal. The LLM proposed an offered source ID,
a read tool, one required input field, a value path, an objective, constraints,
and an `any`, `unique`, or `all` mode. Source and tool fields used explicit enums.

Code copied scalar values from the selected collection. It rejected invalid or
transformed schema inputs, non-scalars, write tools, and procedures containing an
already attempted candidate. That last rule was conservative: it did not combine
prior reads with the uninspected remainder. Source freshness referred to the latest
observed result of the same call, not to unobserved external changes.

Prepared reads went through the normal executor and all its policy, inspection,
authorization, confirmation, and budget checks. Code selected the next reference;
it did not regenerate arguments or invoke global selection for each read. Jev's
optional `evaluateDiscovery` hook saw the objective, constraints, and returned
record and produced `match`, `no_match`, or `uncertain` with model and usage data.

Uncertainty, failed reads, lost availability, and budget exhaustion returned control
to ordinary reasoning. `any` could stop after a match; `unique` retained ambiguity;
`all` tried to cover the collection. `maxCalls` bounded both reads and planning
attempts per turn. Negative planning results did not persist as cross-turn bans.

`data-discovery` events persisted coverage, evidence references, judgments, and stop
reasons. The execution-state version changed from 4 to 5. Controller and response
prompts received these records with explicit limits: they were not completion proof
or permission to mutate. The bridge recorded plans, rejection reasons, checks, and
final procedure state, and exposed discovery and pinned Jev model environment options.

## Development sequence and preserved failures

1. **Initial implementation and generic validation.** Tests used synthetic document
   and device catalogs, renamed tools, negative inputs, ambiguity, failed checks,
   policy boundaries, limits, disabled mode, and state persistence. Benchmark-specific
   fixtures were not embedded in runtime behavior.
2. **First live airline screen exposed model forwarding.** The bridge omitted the
   core arguments-model option, so discovery planning used the full reasoning model.
   The run was stopped with only seven saved results. Planning latency and token use
   were excessive. The bridge forwarding was fixed.
3. **Second screen exposed source selection.** An unconstrained source string let
   the planner return tool or field names instead of offered collection IDs. The run
   was stopped after four saved tasks. Source and tool choices were constrained with
   enums and clearer field descriptions.
4. **Live synthetic smoke.** A document example used a prepared index lookup, the
   real planner, and real Jev. It inspected three records and found the right one in
   about 2.5 seconds, with one plan generation and one response. Because the initial
   lookup was prepared, this was a component test, not an open-ended benchmark.
5. **Final ten-task screen.** The corrected candidate passed 9/10. It stayed opt-in;
   wrong-tool reads and missed writes remained.
6. **Full fifty-task run.** At the user's request, the same runtime ran all tasks
   0–49 fresh, without changing code or rerunning a baseline. It passed 34/50.
7. **Retirement.** The user requested an archive commit, a complete Markdown record,
   and removal of the code because it would not be merged. The archive was committed
   first, this record was written next, and code removal followed.

| Run suffix under Tau simulations                       | Saved tasks | Passed | Status                                           |
| ------------------------------------------------------ | ----------: | -----: | ------------------------------------------------ |
| `keeled_discovery_continuation_first10_20260920`       |           7 |      3 | Interrupted setup run; three saved task timeouts |
| `keeled_discovery_continuation_fixed_first10_20260920` |           4 |      4 | Interrupted setup run; invalid source proposals  |
| `keeled_discovery_continuation_enum_first10_20260920`  |          10 |      9 | Final development screen                         |
| `keeled_discovery_continuation_full50_20260920`        |          50 |     34 | Full run of unchanged final candidate            |

The first setup run recorded 48 plans, about 1,073 aggregate planning seconds, and
more than 200,000 reasoning tokens. Its saved agent-plus-Jev cost estimate was $0.6174.
The second setup run's saved estimate was $0.2192. Interrupted and unsaved work is
not fully accounted for. These partial runs are neither full ten-task scores nor
repeat trials of the final configuration and must not be pooled.

## Final configuration and provenance

Both completed candidate runs used seed 300, one trial, concurrency 3, 200 steps,
a 300-second task timeout, and zero retries. Generation and turn limits were 60 and
240 seconds. Agent model: `deepseek/deepseek-v4.1-flash`, configured routing Together
then Modal; actual resolved upstream provider per generation was not captured.
Discovery planning used the arguments model with reasoning disabled. Jev was pinned
to `jev-1.13.0`; live record-check responses confirmed it. The user simulator was
`openrouter/openai/gpt-4.1`.

Tau recorded commit `b7ea9074c1cba482b30687fecdb5c8425fd6f619`.
The final runtime fingerprint was
`9704d4045fb0f8448bfcd1dcba1e7ce5a72ace129d20b388b5cd2020b727dec5`,
verified before and after the full run. It hashes the sorted per-file SHA-256 map
of immediate TypeScript sources in core, Jev, and bridge source directories.

The full command, run from the experiment worktree, was:

```bash
KEELED_DISCOVERY=1 KEELED_JEV_MODEL=jev-1.13.0 KEELED_BRIDGE_PORT=8798 \
  bun --env-file=/Users/caseycollins/projects/tau2-bench/.env run tau3:first airline 50 \
  --seed 300 --max-concurrency 3 --max-steps 200 --timeout 300 --max-retries 0 \
  --save-to keeled_discovery_continuation_full50_20260920
```

Reproduction requires the archived candidate and external Tau data and credentials.
The retained documentation alone does not provide a runnable discovery feature.

## Measured outcomes

| Metric                                       | Final first ten |  Full fifty |
| -------------------------------------------- | --------------: | ----------: |
| Success                                      |            9/10 | 34/50 (68%) |
| Task-level timeouts                          |               0 |           0 |
| Median latency                               |          58.9 s |      75.0 s |
| p90 latency, nearest rank                    |         108.6 s |     159.3 s |
| Generations                                  |             333 |       1,745 |
| Failed generations                           |               2 |           8 |
| Global selection attempts                    |             172 |         954 |
| External tool calls                          |              49 |         268 |
| Discovery planning generations               |              81 |         411 |
| Accepted discovery procedures                |               7 |          38 |
| Prepared reads                               |              18 |         107 |
| Successful record checks                     |              16 |         101 |
| Wrong-tool reads returning errors            |               2 |           6 |
| Successful write receipts                    |               2 |          24 |
| Successful writes matching reference actions |               2 |          21 |
| Unmatched reference writes                   |             2/4 |       28/49 |
| Repeated identical write attempts            |               0 |           0 |
| Writes outside reference actions             |               0 |           3 |
| Estimated agent + Jev cost                   |         $0.6240 |     $4.3589 |
| Recorded simulator cost                      |         $0.1711 |     $0.7251 |
| Combined estimated cost                      |         $0.7951 |     $5.0840 |
| Agent + Jev cost per success                 |         $0.0693 |     $0.1282 |
| Combined estimated cost per success          |         $0.0883 |     $0.1495 |

The full run's first ten tasks passed 8/10, versus 9/10 in the separate development
screen. The overlapping samples show variation and must not be treated as independent
held-out evidence. All fifty unique IDs 0–49 had saved results.

Costs use historical normalized rates: $0.30/$1.20 per million agent input/output
tokens and $0.042 per million Jev input tokens. They are estimates, not verified
current invoices. Failed generations may lack token usage. Full-run estimates
include failed tasks. Setup costs are separate and exclude unsaved work.

A saved first-ten reference (`keeled_codex_simple_single_20260919`) passed 8/10,
with median 53.6 seconds, p90 106.4 seconds, 421 generations, 401 selection attempts,
39 external calls, and estimated agent-plus-Jev cost $0.7877 ($0.0985 per success).
It had one successful write and three missed reference writes. Source, resolved
model provenance, prompts, and run conditions differed. The first candidate screen
was cheaper but slightly slower; neither difference establishes causation.

A historical 36/50 run lacked actual agent-model provenance; another full run used
a different simulator. Neither is a matched full-run baseline. No claim of a gain
or regression against main is justified by these comparisons.

## What the traces showed

All prepared inputs in both completed screens contained values from prior tool
results. Provenance prevented invention but did not ensure the correct entity type.
The first screen sent flight reference `HAT045` to reservation lookup and reservation
reference `7WPL39` to user lookup. The full run made six analogous mistakes in tasks
11, 12, 17, 18, 33, and 49. All returned not-found errors and stopped discovery.

In the full run, 23 procedures finished and 15 stopped incomplete: eight uncertain
judgments, six failed reads, one discovery budget limit. Planning consumed 262.1
aggregate seconds; Jev record checks consumed 19.6 seconds. These are summed stage
times, not wall-clock duration. There were 277 planner declines, 71 non-scalar
binding rejections, and 25 previously attempted-candidate rejections. Roughly 3.8
planning calls per prepared read is substantial overhead.

Some objectives asked for general details rather than a predicate over one record.
In first-screen task 8, all five records were read without positive matches, and the
ordinary controller still completed the booking. Deterministic iteration can help
without proving that the semantic checks added value. This experiment did not
isolate Jev's incremental contribution.

Zero task-level timeouts in the full run does not mean no timeout failures.
Completion-verification generations timed out in tasks 3, 10, 33, and 44.
Task extraction failed to parse in tasks 0, 4, 14, and 19. Task 23 had three runtime
`limit` stops. It cancelled an old booking but never completed its replacement.

## Write and failure audit

Tool error flags and successful receipts were checked separately from Tau action
matches. Tau compares attempted calls, so an action match alone does not prove a
write succeeded. Full-run matching used Tau's `compare_args` behavior; the earlier
screen's matching writes also matched exact reference arguments.

All 24 full-run write attempts returned successful receipts. Twenty-one matched
reference actions. The three other writes require different interpretations:

- **Task 18:** the agent pushed for one refund method for all downgrades. The user
  approved a credit card, and one downgrade used it instead of the reference's
  original gift card. This was user-approved scope drift, not an unapproved write.
  Two other downgrades remained incomplete.
- **Task 24:** the agent required a specific destination instead of searching the
  cheapest direct West Coast trip. The user chose Los Angeles and approved a $163
  booking, while the reference was a $106 Seattle trip. The narrower booking was
  confirmed, but the original broader search was not fulfilled.
- **Task 35:** the agent saw $163, $290, and $300 options and incorrectly called
  $300 the second cheapest. It booked that option after confirmation. This was a
  concrete numeric-ranking error. It later said it could not finalize the booking,
  despite a successful tool receipt. Confirmation did not repair the false premise.

The 28 unmatched reference writes include alternatives above; they are not all
operations that were never attempted. No repeated identical write attempts were
observed. This audit is not proof that every write met every policy requirement.

Other failures involved missed changes, premature refusal or transfer, incomplete
answers, and unresolved dependencies. Task 7 missed an upgrade and cancellation;
task 3 missed the numeric baggage allowance. In the first-ten screen, task 7 also
missed the required $1,628 total and repeatedly requested transfer confirmation.

Full-run failed task IDs: **3, 7, 12, 14, 15, 18, 22, 23, 24, 29, 32, 35, 37, 39, 42, 44**.
Expected read checks matched 74/91, and write checks matched 21/49. Discovery does
not solve the wider controller, retained-constraint, policy, ranking, and response
accuracy problems shown by these trajectories.

## Validation and decision

Before retirement, `bun run check` passed lint, formatting, TypeScript, and 126 tests.
Coverage included renamed catalogs, direct/nested bindings, schema transforms,
write exclusion, policy denial, failed reads/checks, ambiguity, budgets, availability,
disabled mode, immutable records, source enums, and model forwarding. The full-run
follow-up rechecked source identity, task coverage, receipts, and report formatting.
Passing these checks did not establish benchmark effectiveness.

After removal, `bun run check` passed again: lint, formatting, TypeScript, and
**111 tests**. Runtime, bridge, tests, and public usage documentation match the
pre-experiment parent exactly. Only experiment records and the index differ.

The user's final decision supersedes the earlier “keep opt-in” recommendation:
**do not merge this implementation; keep the evidence and remove the code**.
The experiment demonstrates working bounded iteration, but not a reliable overall
improvement. It does not prove that all continuation designs or narrow Jev judgments
are ineffective. There was no repeated held-out multi-domain evaluation, no matched
control, and no ablation separating deterministic iteration from semantic checks.

Future work should treat binding compatibility, planner overhead, exact numeric
ordering, retained constraints, and write-receipt reporting as separate hypotheses.
Any future implementation must use general mechanisms and ordinary tool contracts,
not airline-specific patches. This record does not authorize or propose another run.

## Retained evidence

- [First screen and setup failures](discovery-continuation.md)
- [First-screen compact metrics](discovery-continuation-metrics.json)
- [Full fifty-task report](discovery-continuation-full50.md)
- Detailed full-run metrics remain in the local Tau result file and archive commit
  `f4d120b`. The large JSON export was removed from the final documentation diff;
  the full-run report preserves the aggregate results and write audit.
- Raw runs remain under `/Users/caseycollins/projects/tau2-bench/data/simulations/`,
  using the four run names above and their `results.json` files.

Raw traces, temporary scripts, and local fingerprints are not portable dependencies.
The committed reports and compact metrics preserve the durable evidence; the archive
commit preserves the exact candidate code. Earlier reports remain historical records,
with retirement notices to prevent their experimental API or adoption status being
mistaken for current support.
