# Bounded discovery continuation: full 50 airline tasks

> Retired after evaluation: the user rejected this implementation for merge and its code was removed.
> This report preserves the assessment at run time. See the [complete experiment record](discovery-continuation-retrospective.md).

Date: 2026-09-20. Decision: **keep experimental and opt-in; do not adopt as default**.

The unchanged candidate passed **34/50 tasks (68%)**. It made useful read sequences,
but missed many requested writes and made one clear numeric-ranking error that
resulted in the wrong booking. This run does not establish an improvement over main.

## Scope and provenance

All tasks 0–49 ran fresh, once, with discovery enabled. No baseline was rerun.
The first ten passed 8/10 in this run, compared with 9/10 in the earlier development
screen. These are overlapping samples, not independent evidence to pool.

- Worktree: `/Users/caseycollins/.codex/worktrees/discovery-continuation/keeled`.
- Branch: `codex/discovery-continuation`; base `73b89e90a1375744a3bc5c362cbe8da6c7ed3d68`, with local changes.
- Runtime fingerprint before and after: `9704d4045fb0f8448bfcd1dcba1e7ce5a72ace129d20b388b5cd2020b727dec5`.
  This hashes the sorted per-file SHA-256 map of immediate TypeScript files in core,
  Jev, and bridge source directories. It matches the final ten-task candidate.
- Tau commit: `b7ea9074c1cba482b30687fecdb5c8425fd6f619`.
- Agent: `deepseek/deepseek-v4.1-flash`; configured routing Together then Modal.
  Actual upstream provider per generation was not recorded. Discovery uses the
  arguments model with reasoning disabled.
- Jev: pinned `jev-1.13.0`, confirmed by all 101 record-check responses.
- Simulator: `openrouter/openai/gpt-4.1`.
- Seed 300, one trial, concurrency 3, 200 steps, 300-second task timeout, zero retries.
  Runtime generation/turn timeouts: 60/240 seconds.

```bash
KEELED_DISCOVERY=1 KEELED_JEV_MODEL=jev-1.13.0 KEELED_BRIDGE_PORT=8798 \
  bun --env-file=/Users/caseycollins/projects/tau2-bench/.env run tau3:first airline 50 \
  --seed 300 --max-concurrency 3 --max-steps 200 --timeout 300 --max-retries 0 \
  --save-to keeled_discovery_continuation_full50_20260920
```

## Results

| Metric                                              |      Result |
| --------------------------------------------------- | ----------: |
| Success                                             | 34/50 (68%) |
| Task-level timeouts                                 |           0 |
| Median task time                                    |      75.0 s |
| p90 task time, nearest rank                         |     159.3 s |
| Recorded generations                                |       1,745 |
| Failed generations                                  |           8 |
| Global controller selection attempts                |         954 |
| External tool calls                                 |         268 |
| Write attempts with successful receipts             |       24/24 |
| Successful writes matching reference actions        |          21 |
| Reference writes without a matching successful call |       28/49 |
| Writes outside reference actions                    |           3 |
| Repeated identical write attempts                   |           0 |
| Estimated agent + Jev cost                          |     $4.3589 |
| Recorded simulator cost                             |     $0.7251 |
| Combined estimated cost                             |     $5.0840 |
| Agent + Jev cost per successful task                |     $0.1282 |
| Combined cost per successful task                   |     $0.1495 |

Cost estimates use the same historical normalization as the first screen:
$0.30/$1.20 per million agent input/output tokens and $0.042 per million Jev input
tokens. They are not verified invoice amounts. Missing token usage on failed calls
can understate cost. Costs include failed tasks; they are not successful-task-only costs.

Zero task-level timeouts does not mean zero internal timeouts. Four generations
timed out (tasks 3, 10, 33, 44), and four task-extraction generations failed to parse
(tasks 0, 4, 14, 19). Task 23 had three runtime `limit` stops and failed after a partial
cancellation/rebooking workflow. All benchmark simulations reached saved results.

Failed task IDs: 3, 7, 12, 14, 15, 18, 22, 23, 24, 29, 32, 35, 37, 39, 42, 44.
Expected read checks matched 74/91; expected write checks matched 21/49. Tau checks
attempted calls; the write audit separately requires successful tool receipts.
The 28 unmatched reference writes include the three alternative writes below and
must not all be described as operations never attempted.

## Write audit

Three successful writes differed from the reference:

- **Task 18:** a downgrade refunded reservation `2FBBAH` to a credit card instead
  of its original gift card. The agent pushed for one payment method for all changes;
  the user explicitly approved that card. This is a reference mismatch and scope
  drift, not evidence of an unapproved write. Two other requested downgrades were
  not completed.
- **Task 24:** the agent booked a $163 Los Angeles round trip after asking the user
  to pick a destination. The original request was the cheapest direct West Coast
  trip; the reference was a $106 Seattle trip. The user approved Los Angeles, but
  the agent failed to perform the requested broader search.
- **Task 35:** the agent listed $163, $290, and $300 options, then called the $300
  itinerary the second cheapest. It booked that itinerary after confirmation.
  This is a concrete ranking error, not merely a different valid search outcome.
  The tool returned a successful booking, but later assistant responses said the
  booking could not be finalized. Confirmation did not correct the false ranking.

There were no repeated identical write attempts. This is not a comprehensive
proof that every confirmed write satisfied every policy requirement.

Other failures included missing changes, premature refusals or transfers, and
incomplete answers. Task 7 omitted the upgrade and one cancellation; task 3 omitted
the required numeric baggage allowance. Task 23 cancelled an old booking but did
not finish the replacement. Discovery does not repair these general control,
constraint-retention, ranking, or write-reporting failures.

## Discovery behavior

- 411 planning generations produced 38 accepted procedures.
- 107 prepared reads: 101 successful records with Jev checks, six failed reads.
- All 107 inputs contained values observed in prior tool results.
- 23 procedures finished; 15 stopped incomplete: eight uncertain judgments,
  six failed reads, and one exhausted discovery call budget.
- Planning took 262.1 aggregate seconds; record checks took 19.6 aggregate seconds.
  These are summed stage times across tasks, not wall-clock run duration.
- Other planning outcomes: 277 declines, 71 non-scalar binding rejections,
  25 rejections because a candidate was already attempted.

The six failed reads selected the wrong entity lookup: tasks 12, 17, 18, and 49
sent reservation references to user lookup; tasks 11 and 33 sent flight references
to reservation lookup. All returned not-found errors and stopped their procedures.
Schema validity and copied values do not prove semantic compatibility.

Some accepted objectives remained open-ended requests for details rather than
record predicates. Iteration can collect useful evidence even when the match
judgments do not add value. This run does not isolate Jev's incremental contribution.
There were roughly 3.8 planner calls per prepared read, so planning overhead remains
material.

## Interpretation and validation

Keep this opt-in. The full set is substantially weaker than the ten-task screen,
and it exposes a real wrong-ranking write plus missed work. No runtime change was
made during this run. A historical 36/50 artifact exists, but its actual agent model
was not recorded; another full run used a different simulator. Neither is a suitable
paired baseline for a claim that discovery improved or worsened performance.

The unchanged candidate previously passed 126 tests, typecheck, lint, and formatting.
This follow-up verifies the full run, its source fingerprint, unique IDs 0–49, tool
receipts, and report formatting. It adds no benchmark-specific runtime behavior.
One trial per task and overlapping development tasks limit generalization.

[Earlier screen, implementation, and preserved setup failures](discovery-continuation.md).
[Compact full-run metrics and audit](discovery-continuation-full50-metrics.json).
Raw results: `/Users/caseycollins/projects/tau2-bench/data/simulations/keeled_discovery_continuation_full50_20260920/results.json`.
Raw traces remain local artifacts; the compact metrics are the durable record.
