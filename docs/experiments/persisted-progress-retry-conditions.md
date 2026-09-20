# Persisted progress and retry conditions: not adopted

Date: 2026-09-20

## Decision

We did not adopt Experiment 1. Persisting exhausted decisions reduced repeated
controller selections and total model calls, but the airline screen did not meet
our acceptance rule: preserve task success without more premature blocking.
Completion-model requests also increased.

The main failure was making an incorrect argument-resolution judgment durable.
A model could say that information was missing even when a valid lookup could
retrieve it. The experiment then excluded that lookup until its retry condition
changed. Fewer attempts did not necessarily mean better progress.

This document records the local experiment. This PR adds no runtime changes.
The results are a reason to reject this candidate, not proof that all persisted
retry mechanisms are ineffective.

## Hypothesis and implementation

The hypothesis was that Keeled could reduce loops without another inference
request by remembering exhausted decisions and the changes needed to retry them.

The candidate extended persisted message state and the reducer with attempt
records tied to an existing task goal, decision or canonical tool input, evidence
revision, outcome, and retry condition. It recorded failed argument resolution,
rejected completion, and calls that produced no new relevant evidence.

Before controller selection, it excluded exhausted resolution choices and rejected
completion decisions. It also enforced exact-input exhaustion before invocation.
Different inputs to the same tool remained legal. A new conversational turn alone
did not reopen a decision; changed instructions, confirmation, or evidence could.
The implementation retained bounded transient retries, polling deadlines, and
successful matching-write evidence as a requirement for write-goal completion.

The experiment used the existing task contract. It added no second planner,
argument ledger, public agent configuration, inference request, or write-approval
layer. The local runner enabled it independently with `--experiment-progress`;
the baseline left it disabled.

Revision tracking used precise dependencies where available and a broader state
revision otherwise. Duplicate errors and identical read observations did not
count as progress. Successful writes invalidated stale read evidence. This was
not a semantic relevance classifier: changed user text could reopen decisions,
and broad revisions could invalidate more cached decisions than necessary.

## Evaluation setup

- Scope: first ten airline cases, IDs 0–9, with two trials per case.
- Seed: 300; concurrency: 3; maximum steps: 200; configured task timeout: 300 seconds.
- Automatic benchmark retries: zero.
- Agent: `deepseek/deepseek-v4.1-flash`, through Together then Modal.
- User simulator: `openrouter/openai/gpt-4.1`.
- Controller: Jev SDK default alias; the resolved model version was not captured.
- Generation timeout: 60 seconds; agent turn timeout: 240 seconds.
- Source base: `800328a572cdaa986faafe0f63c97058f840c8fb`, with local experimental changes.

The saved historical baseline was incompatible with the current task tracker,
argument handling, and harness. We therefore refreshed the baseline with the
experiment disabled. Experimental changes made during that baseline run were
inactive with the flag off. Sources were frozen before the candidate run, and
source hashes were checked afterward. Saved task definitions, configuration, and
seeds matched across the 19 shared task/trial pairs.

Both complete first trials scored 8/10. The baseline saved all 20 results, with
16 successes. The candidate saved 19 results, with 15 successes. Case 7, trial
index 1, stalled; its last logged elapsed time was 7,401 seconds, well beyond the
configured timeout. We stopped the benchmark without replacing that run. It has
no saved evaluator score, trace, or usage. It is an unsuccessful completion of the
planned cohort, not an invented evaluator failure.

The table below compares only the same 19 saved pairs. These repeated cases were
not a separate unseen task cohort. The measurements apply to the recorded source
base, not to later changes on `main`.

## Results on matched saved runs

| Metric                                                  | Baseline | Experiment |
| ------------------------------------------------------- | -------: | ---------: |
| Task successes                                          |    16/19 |      15/19 |
| Repeated-selection proxy                                |      198 |          6 |
| Controller selection calls                              |      516 |        374 |
| All Jev calls, including authorization                  |      542 |        386 |
| Completion-model requests                               |       21 |         34 |
| Generation attempts                                     |      666 |        549 |
| Failed generation attempts                              |        1 |         22 |
| Blocked turns                                           |       39 |         68 |
| Missed reference writes                                 |        3 |          4 |
| Issued mutation arguments unmatched to reference writes |        0 |          0 |
| Duplicate reference writes                              |        1 |          0 |
| Median saved-run latency                                |   60.7 s |     58.0 s |
| p90 saved-run latency                                   |  161.5 s |    222.8 s |
| Estimated agent cost per success                        |  $0.0835 |    $0.0605 |
| Estimated cost per success, including user simulator    |  $0.1000 |    $0.0830 |

The repeated-selection proxy counts the same controller action against unchanged
latest user text and successful external-tool evidence. It does not fully capture
resolved arguments, local evidence, arithmetic, or task-state changes. It is not
a definitive loop count. A repeated tool name alone is not a loop. A narrower
count of exact repeated external invocations on unchanged user/external evidence
was zero in both conditions. The baseline duplicate write followed a new user turn.

Completion was excluded in 48 candidate controller contexts, but changed text,
task state, or evidence reopened later checks. The candidate still made more
completion-model requests overall.

Latency uses saved runs only, with nearest-rank p90. Cost estimates use recorded
tokens and uncached rates of $0.30/$1.20 per million agent input/output tokens and
$0.042 per million Jev input tokens. They are estimates, not invoices. They exclude
the interrupted run and any unreported billed failures or retries and do not model
cache discounts. Lower cost may partly reflect earlier blocking.

## What the failure review showed

We manually reviewed all 68 saved candidate blocked turns. They were not all
incorrect: some enforced policy or retained unfinished goals after a useful
partial answer. The interrupted run could not be reviewed.

The clearest new scored failure was case 3, trial index 1. The baseline passed
both trials. The candidate already had the user identifier needed to look up
membership and determine a baggage allowance. Argument resolution nevertheless
reported missing information. Persisting that judgment excluded the valid
profile lookup, and the agent never supplied the required number.

Other saved trajectories blocked despite available identifiers or demanded the
output of a lookup before allowing that lookup. Similar resolution errors already
existed in the baseline. Persistence made these uncertain model judgments affect
later choices; differences in full trajectories prevent attributing every blocked
turn to this mechanism alone.

Write results also gave no basis for adoption. Missed reference writes increased
from three to four in matched runs. Case 7's saved candidate trial completed one
cancellation but missed another cancellation and an upgrade. Both case 8 booking
trials failed. No issued mutation arguments were unmatched to the reference
writes, but that narrow check is not a complete safety evaluation.

Existing authorization checks rejected a proposed repricing write in case 9.
The response then incorrectly described a payment-processing failure even though
no write had been issued. This is a response-grounding failure, not an observed
wrong write. Database reward alone can also pass when the database remains
unchanged despite missed useful reads or unsupported answers.

The candidate had 22 failed generation attempts versus one baseline failure,
including parsing failures and timeouts. These affect latency and cost. The cause
of the interrupted run was not established, and neither its stall nor all provider
failures can be attributed to persisted attempts from this evidence.

## Validation and lessons

The experimental implementation passed 109 tests, plus lint, formatting, and type
checks. Synthetic tests covered unrelated settings and renamed tools, cross-turn
and alternating failures, rejected completion reuse, changed instructions and
confirmation, dependency changes, transient failures, polling, changed external
state, distinct inputs to the same tool, and successful matching-write evidence.
These checks established mechanism behavior, not reliable live task completion.
They were checks on the local implementation, not tests of code shipped by this PR.

The acceptance rule required fewer repeated decisions and model calls without
lower task success or more premature blocking. This candidate failed that rule.
The small, incomplete screen does not support a statistical claim about the size
of the regression, but it does not justify adoption.

A future attempt should distinguish an uncertain resolution judgment from a
proven missing dependency and retain bounded recovery from false missing-input
claims. Dependency invalidation should follow runtime evidence. Improvements must
remain general and preserve write-evidence requirements; benchmark-specific
exceptions would not address the failure. A new candidate needs a compatible
comparison and review of every new blocked outcome before adoption.

## Evidence provenance

The local evidence bundle was kept under ignored `reviews/progress/`: `report.md`,
`summary.json`, `manifest.json`, `baseline/results.json`, `candidate/results.json`,
`interrupted.json`, and `blocked-review.md`/`blocked-review.json`, with analysis
scripts and logs. This documentation-only PR does not include those artifacts or
the experimental implementation. A fresh clone cannot independently recompute
these measurements from this document alone.
