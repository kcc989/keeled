# Queryable context: implementation and validation

Date: 2026-09-21. Worktree base: `73b89e90a1375744a3bc5c362cbe8da6c7ed3d68`.

## Acceptance criteria

The user requires working behavior, improved LLM performance with less context,
and meaningful gains in at least two of accuracy, latency, and cost, with no more
than a 20% regression in the third. Incorrect writes remain a separate safety
measure and must not be hidden by aggregate task success. Full ten-case screens finish before a candidate
is judged. Ten cases are fault screens, not broad proof. Repeated held-out cases
and controlled context comparisons are needed before a general improvement claim.

## Local implementation

The fact catalog and shared context assembly are the default. Sources, records,
passages, derived quotes, and lifecycle updates persist with messages. Jev supplies
bounded semantic judgments. Source lookup, indexing, validation, revisions, budgets,
and execution transitions remain code-owned. Local arithmetic/evidence tools and
paging prompts are removed. Tau preserves risk-based input models and external calls.

`bun install --frozen-lockfile`, `bun run check`, and `git diff --check` pass.
There are 123 deterministic tests in the latest local check (117 at the second screen's start). New tests cover
exact records and UTF-16 passages, provenance and container links, hydration,
bounded indexing continuation, cache invalidation, incomplete comparisons,
source corrections, rejected extraction, cancellation, source isolation, typed
Jev candidates, and the real bridge callback path with renamed tools. Existing
permission, validation, confirmation, repeat, polling, and uncertain-write tests pass.

## First full screen: failed candidate

All ten airline cases completed once with seed 300, concurrency 3, 200 harness
steps, 60-second generation and 240-second turn deadlines. The run used the normal
Jev controller, `deepseek/deepseek-v4.1-flash`, Together/Modal routes, and the existing
risk-based model settings. User simulation used `openrouter/openai/gpt-4.1`.

| Metric                          | Historical reference | First catalog candidate |
| ------------------------------- | -------------------: | ----------------------: |
| Task success                    |                 8/10 |                    7/10 |
| Median task seconds             |                53.64 |                  102.36 |
| p90 task seconds                |               106.36 |                  132.22 |
| LLM calls, returned turns       |                  421 |                     432 |
| LLM input tokens                |            1,757,977 |               8,909,135 |
| LLM output tokens               |               69,322 |                  68,407 |
| Controller calls                |                  418 |                     883 |
| Controller input tokens         |            4,216,077 |              23,289,357 |
| Issued reference-typed writes   |                    1 |                       0 |
| Missed reference writes         |                    3 |                       4 |
| Missed reference reads          |                    3 |                      10 |
| Query attempts / cache hits     |       Not applicable |               720 / 111 |
| Failed query attempts           |       Not applicable |                       0 |
| Median / p90 query milliseconds |       Not applicable |               432 / 640 |
| Uncached list-price estimate    |              $0.7877 |                 $3.7330 |
| Estimated cost per success      |              $0.0985 |                 $0.5333 |

The candidate failed cases 3, 7, and 8. No case had a harness timeout; case 8 took
275.4 seconds and several turns ended in runtime errors. Four generative calls
failed. Successful DB rewards do not establish full task completion: the run
missed required reads and issued no writes. There were no observed duplicate write
attempts, but this is not evidence of better safety because useful writes were missed.

The candidate clearly fails acceptance. It copied policy, user messages, and contracts
both as mandatory content and as retrieved evidence. Selected full sources could then
appear again. This expanded LLM input rather than reducing it. Several runtime errors
were not explained in the returned diagnostic trace, so their causes are not inferred.

The reference is `keeled_codex_simple_single_20260919`; it is the saved reference used
in earlier repository reports. Models, seed, and task IDs match, but source revisions,
validation, controller behavior, and provider conditions differ. This is historical
context, not a paired causal experiment.

Costs use $0.30/$1.20 per million LLM input/output tokens for the configured Together
and Modal routes, verified on [OpenRouter](https://openrouter.ai/deepseek/deepseek-v4.1-flash),
and $0.042 per million Jev input tokens with unmetered outputs from
[TypeSafe](https://typesafe.ai/blog/introducing-system-one-models-and-jev), checked on
2026-09-21. These are uncached list-price estimates, not invoices. Provider cache
reuse and failures without returned usage limit comparison. User simulator cost is
excluded. No actual-dollar saving is established.

## Second candidate

The second screen separates mandatory content from semantic candidates for built-in
decisions, ranks observations, avoids duplicate instruction/evidence copies, and adds
a bounded judgment for exhaustive comparison scope. It preserves complete selected
sources when comparison or text scope requires them. Call references now reach
completion consumers explicitly. Runtime exceptions are included in diagnostics.

The second run also completed all ten cases before review. It is stored at
`data/simulations/20260921_170023_airline_keeled_keeled_user_simulator_gpt-4.1/results.json`.
Its compact record is `second-metrics.json`.

| Metric                        | Historical reference | Second catalog candidate |
| ----------------------------- | -------------------: | -----------------------: |
| Task success                  |                 8/10 |                     8/10 |
| Median task seconds           |                53.64 |                    68.40 |
| p90 task seconds              |               106.36 |                   162.69 |
| LLM calls                     |                  421 |                      218 |
| LLM input tokens              |            1,757,977 |                1,284,928 |
| LLM output tokens             |               69,322 |                  121,905 |
| Controller calls              |                  418 |                      418 |
| Controller input tokens       |            4,216,077 |                6,206,661 |
| Issued reference-typed writes |                    1 |                        4 |
| Missed reference writes       |                    3 |                        1 |
| Writes unmatched to reference |                    0 |                        1 |
| Duplicate write attempts      |                    0 |                        0 |
| Query attempts / cache hits   |       Not applicable |                 358 / 33 |
| Uncached list-price estimate  |              $0.7877 |                  $0.7924 |
| Estimated cost per success    |              $0.0985 |                  $0.0991 |

This restores the historical task score and reduces LLM input by 26.9%, but median
latency rises 27.5% and p90 rises 53.0%. The cost estimate is essentially unchanged.
It fails the 20% latency tolerance. These comparisons retain the historical-baseline
confounds above and do not establish causation.

Cases 7 and 8 failed. Case 7 missed the requested total. In case 8, the user explicitly
said no baggage for either traveler, but the eventual booking supplied two checked
bags instead of zero. The assistant had incorrectly described included baggage in
its confirmation summary, and the later confirmation did not reliably preserve the
original restriction. This is a real argument/constraint failure, not a retrieval
success or proof of safety. No domain-specific baggage rule was added to Keeled.

The new runtime trace exposed four errors: two empty structured outputs and two
unparseable structured outputs. There were no query failures or harness timeouts.
The longest case took 206.5 seconds. Runtime code was held fixed during both screens.
After the screens, local hardening added transitive derived-fact invalidation, checked
that copied spans belong to declared dependencies, froze reduced catalog state against
callback mutation, and retained known usage when structured output validation fails.
These changes had deterministic coverage at that stage and were subsequently exercised in the third and later full screens.

## Controlled full-history versus catalog test

The independent script is
[`examples/tau-bridge/eval/fixed-context.ts`](../examples/tau-bridge/eval/fixed-context.ts).
It asks the same model the same fixed questions about file records and inventory,
with 160 supplied records per setting, ten questions, two repetitions, and alternating
mode order. Four questions are repeated no-match cases. The model, output contract,
settings, and observations are held fixed. Full-history context places observations
before the changing question to preserve ordinary prompt-cache reuse.

| Metric, 20 requests per mode                 |   Full history | Catalog context |
| -------------------------------------------- | -------------: | --------------: |
| Correct answers                              |          20/20 |           20/20 |
| LLM input tokens                             |        155,200 |          61,680 |
| Reported cached input tokens                 |        139,392 |          30,080 |
| Jev input tokens                             |              0 |         438,054 |
| Median end-to-end milliseconds               |          293.0 |           739.4 |
| p90 milliseconds                             |          737.7 |         1,504.8 |
| Median context preparation milliseconds      |              0 |           384.6 |
| Median repeated unchanged query milliseconds | Not applicable |           0.282 |
| Labeled positive source hits                 | Not applicable |           16/16 |
| Cache-aware estimate, Together rates         |       $0.00574 |        $0.02821 |
| Cache-aware estimate, Modal rates            |       $0.00908 |        $0.02893 |

This establishes unchanged answer accuracy with 60.3% fewer LLM input tokens on these
specific fixed questions. It does not establish improved answer accuracy. It also
shows 2.52x median latency and higher estimated total cost once Jev input and reported
LLM caching are included. Fewer LLM tokens alone are not a cost improvement.

The price range applies the two configured providers' published cache-read rates
($0.006 and $0.030 per million tokens); actual selected-provider invoices were not
captured. The script reports cold query preparation and a repeated unchanged query
separately. Fixture catalog construction is measured, but this is not a complete
cold-session/backfill evaluation. Cache reuse is run-local. The fixed-state experiment
is an isolation test of context preparation, not a full-agent or write-safety test.
Its limited exact-record cases do not prove broad retrieval recall.

The compact result is `experiments/queryable-context/fixed-state-results.json`.
Raw rows are retained locally under ignored `reviews/queryable-context/fixed-state/`.
At this stage, no repeated held-out full-agent evaluation had run: that candidate
failed the agreed acceptance limits. Later screens and the invalid held-out attempt
are recorded below; the controlled large-scope result remains a limitation.

## Evidence and limitations

Compact measurements and the generic extraction script are in
[`experiments/queryable-context`](../experiments/queryable-context).
The first run is stored in the Tau checkout at
`data/simulations/20260921_164726_airline_keeled_keeled_user_simulator_gpt-4.1/results.json`.
An exact first-candidate runtime patch and new source files are retained locally in
ignored `reviews/queryable-context/pilot/`; the patch SHA-256 is
`3715ba23c6ce6102e3727070e3012b747e232f507e3e679f29531a8bde58f81a`.
Raw traces and source snapshots are local artifacts, not portable repository dependencies.

The full-agent telemetry does not provide labeled retrieval recall, a full cold-ingestion
versus warm-query cost split, resolved Jev model versions, or provider invoice/cache
charges. Reference-write matching is narrower than a complete intent/safety review.
The catalog's coverage flags are conservative: semantic filtering is incomplete by
definition, so an incomplete flag is not itself an observed retrieval error.

No broad accuracy, speed, cost, or context-efficiency improvement has been proved.

## Third full screen: exact small scopes

This candidate retained all fully indexed tool observations directly when their
combined JSON content fit 12,000 characters. Public queries remained semantic.
No tool names, field names, or domain rules participate in this threshold.
All ten cases finished before assessment. Settings match the second screen.
The source snapshot is `reviews/queryable-context/third/`; compact metrics are
`experiments/queryable-context/third-metrics.json`.

| Metric                       | Historical reference | Third candidate |
| ---------------------------- | -------------------: | --------------: |
| Task success                 |                 8/10 |            9/10 |
| Median seconds               |                53.64 |           94.02 |
| p90 seconds                  |               106.36 |          180.54 |
| LLM input tokens             |            1,757,977 |       1,562,919 |
| LLM output tokens            |               69,322 |         161,718 |
| Controller calls             |                  418 |             182 |
| Controller input tokens      |            4,216,077 |       2,418,393 |
| Uncached list-price estimate |              $0.7877 |         $0.7645 |

All 418 internal context requests used exact small scopes; total recorded lookup
time fell below one second, from 85.2 seconds in the second screen. Completion
verification instead used 537.6 aggregate seconds across 22 calls, including
84,960 reasoning tokens. These are sums across concurrent tasks, not wall time.
There were two reference-typed writes, no unmatched or duplicate writes, and two
missed reference writes. Case 7 failed both the final state and required answer.
Three runtime errors were recorded. The local check passed 122 tests.

This screen does not meet acceptance: latency exceeds the 20% allowance and the
estimated cost reduction is small. The 9/10 score is one trial, not proof of improved
accuracy. Prices exclude cache discounts and user simulation; no billed savings
are established. The next candidate must address completion-check overhead while
preserving evidence checks. No business-specific correction was introduced.

## Fourth full screen: bounded completion model route

This candidate kept the third screen's runtime and supplied the existing
non-reasoning structured model as `modelTaskTracker.verificationModel`. An omitted
verification model still uses the agent default. Authorization, write-argument
models, evidence-reference validation, and required-write checks were unchanged.
All ten cases finished. Settings otherwise match the previous screen.

| Metric                       | Historical reference | Fourth candidate |
| ---------------------------- | -------------------: | ---------------: |
| Task success                 |                 8/10 |             8/10 |
| Median seconds               |                53.64 |            44.15 |
| p90 seconds                  |               106.36 |           140.30 |
| LLM input tokens             |            1,757,977 |        1,438,761 |
| LLM output tokens            |               69,322 |           58,871 |
| Controller calls             |                  418 |              171 |
| Controller input tokens      |            4,216,077 |        2,300,472 |
| Uncached list-price estimate |              $0.7877 |          $0.5989 |

Median latency fell 17.7% and estimated uncached cost fell 24.0% relative to the
historical reference, at the same observed success rate. P90 latency rose 31.9%,
so slower-case performance remains a material regression. All four reference-typed
writes matched, with no missed or duplicate writes. Cases 3 and 7 failed to
communicate requested answers; both final database checks passed. Five runtime
errors were recorded. Completion checks took 138.7 aggregate seconds across 16
calls, with 3,925 output tokens and no reported reasoning tokens.

The score does not establish improved LLM accuracy. Nor do these measurements
attribute gains to the reducer: model routing changed. A fresh reference using
base `73b89e90a1375744a3bc5c362cbe8da6c7ed3d68`, the same completion model, and the
same failed-generation accounting fix is required for that comparison. The base
retains its prior tool surface and prompts, so even that comparison tests the
whole implementation rather than an isolated causal effect of the reducer.

Compact metrics: `experiments/queryable-context/fourth-metrics.json`. Exact local
snapshot: `reviews/queryable-context/fourth/`. The reference's base identity and
three modified files are archived under `reviews/queryable-context/matched-reference/`.

## Matched-model reference, full ten cases

The reference described above finished all ten tasks, with 111 local tests passing
before execution. The fresh run reached 8/10, a 64.62-second median, 175.30-second
p90, 1,190,374 LLM input tokens, and a $0.6397 uncached list-price estimate. It
issued two reference-typed writes, missed two reference writes, and had no
unmatched or duplicate writes. Results are in `matched-reference-metrics.json`.

Against this reference, the fourth candidate was 31.7% faster at the median,
20.0% faster at p90, and 6.4% cheaper by the uncached estimate, at the same success
rate. However, it used 20.9% more LLM input. Task extraction alone used 375,420
input tokens in the candidate versus 129,723 in the reference. It therefore still
does not meet the less-context requirement. The next candidate narrows this
source-quoted update to the current user message, existing task contract, and
preceding assistant message. It also removes the redundant task copy in completion
prompts. Other consumers retain the shared decision packet.

The reference and candidate run sequentially, not interleaved. Provider load,
cache state, stochastic trajectories, the retained legacy tool surface, and one
trial per task limit causal and statistical conclusions. No broad improvement
claim follows from this screen alone.

## Fifth full screen: task updates use only conversational inputs

The frozen candidate narrows task updates as described above and removes a
duplicate task object from completion prompts. No controller rules, tool contracts,
write checks, or domain adapters changed. It passed 123 local tests. Cache-token
fields were added to diagnostics without changing model requests. All ten tasks
finished before assessment.

| Metric                        | Matched-model reference | Fifth candidate | Change |
| ----------------------------- | ----------------------: | --------------: | -----: |
| Task success                  |                    8/10 |            8/10 |   Same |
| Median seconds                |                   64.62 |           35.21 | -45.5% |
| p90 seconds                   |                  175.30 |           65.30 | -62.8% |
| LLM input tokens              |               1,190,374 |         943,992 | -20.7% |
| LLM output tokens             |                  90,299 |          56,550 | -37.4% |
| Controller input tokens       |               4,148,754 |       2,023,934 | -51.2% |
| Uncached list-price estimate  |                 $0.6397 |         $0.4361 | -31.8% |
| Reference-typed writes issued |                       2 |               1 |  Fewer |
| Missed reference writes       |                       2 |               3 |   More |
| Unmatched / duplicate writes  |                   0 / 0 |           0 / 0 |   Same |

This meets the aggregate numerical development screen for speed, estimated
uncached cost, task score, and reduced LLM input. It does not establish improved
write completion or broad accuracy. The candidate reported 413,440 cached input
tokens across all 218 model calls. Using the two configured providers' cache rates,
its cache-adjusted estimate is $0.3145–$0.3244. The reference did not record cache
usage, so no cache-adjusted savings comparison is claimed. Actual invoices and
user simulator costs are not included.

The first ten cases have been used repeatedly for development. Freeze this
candidate before evaluating untouched tasks 10–19 against the reference. Both
held-out runs must record cache detail and finish all ten cases before assessment.
No changes based on their partial results are allowed. Existing unrelated synthetic
fixtures test the generic mechanisms; they do not establish broad live performance.

Metrics: `fifth-metrics.json`. Local source snapshot:
`reviews/queryable-context/fifth/`. Runtime behavior remains frozen for held-out
validation; subsequent documentation and metric extraction do not change execution.

## Held-out validation blocked by provider allowance

The frozen reference attempted tasks 10–19. OpenRouter rejected requests because
the configured credit allowance could not cover the requested token limits. The
runner exited and saved ten entries, but only five were scored; five ended with
`infrastructure_error`. Their saved trajectories are empty and their durations
are zero, so they must not be used as failures, fast tasks, or zero-cost work.
The run cannot support a held-out performance judgment. No candidate held-out
run was started. Spending limits and generation limits were not changed.

The invalid attempt is recorded in `heldout-reference-invalid.json`. The raw run
is `20260921_175143_airline_keeled_keeled_user_simulator_gpt-4.1/results.json` under
the local Tau simulations directory. The local runner log is
`/tmp/keeled-heldout-reference.log`; it can contain provider account identifiers
and is not committed. Resume only after the provider allowance is restored, with
the same frozen reference and candidate. Re-run all ten reference cases rather
than combining this incomplete run with a new provider state.

Current conclusion: the implementation passes 123 local tests and the development
screen demonstrates lower input, median latency, p90 latency, and estimated
uncached cost at the same task score. Write completion regressed in that screen.
The broader goal remains unproved because the held-out comparison is unavailable.

## Post-screen grounding correction (not live-evaluated)

A read-only provider check confirmed $0.023976587 remaining under the configured
$50 key allowance. No further billable requests were made.

Review of the fifth candidate's saved case 8 found that the actual empty search
used one date, but subsequent assistant replies described it as a search of a
different date. The source retained the exact input, but expanded decision evidence
placed result content separately from that input in call history. This is a general
scope-grounding failure, not evidence that the later requested scope was empty.

Current local code includes the originating tool, exact arguments, and call reference
next to expanded observation content and in selected-fact provenance. The shared
coverage rule explicitly limits an observation to its recorded arguments. Tests use
unrelated document and warehouse tools with empty results and changed query scopes.
No business rule or benchmark field was added. All 124 local tests pass.

This is a post-screen candidate change. The fifth candidate's performance numbers
do not validate it or establish that the model now obeys scope binding. Its exact
previous source remains archived. A new complete live screen is required after
provider allowance is restored; neither partial results nor local tests prove the
performance objective.

## User-approved expansion gate and external comparison

After the latest candidate completes the full ten-case screen, expand to all 50
Airline tasks if the agreed gains hold. Do not treat the earlier fifth-candidate
numbers as validation of the subsequent scope-grounding change. Freeze the accepted
candidate for the 50-task run and report every task, including errors and limits.
The prior proposed intermediate held-out screen is superseded by this expansion
sequence; the failed infrastructure attempt remains preserved.

Compare with https://openrouter.ai/benchmarks/tau2-bench-airline#tool-calls,
refreshed when the full run finishes. OpenRouter's methodology, checked on
2026-09-21, uses gemini-2.5-flash for the user simulator; our historical screens used
openrouter/openai/gpt-4.1. Its cost, time, and output-token columns are task means,
not medians. Headline results use default routing when available and aggregate
runs with at least 45 graded tasks per model-provider pair. Record these differences
and verify dataset, policy, scoring, model reasoning, and trial settings before
claiming equivalent conditions. All future runs must use openrouter/google/gemini-2.5-flash, per the user
instruction. Run both the reference and current candidate afresh with Gemini for
the ten-case gate; historical GPT-4.1 runs are background evidence only.

Report task success, completed and incorrect writes, mean and median latency,
p90 latency, full agent-plus-Jev cost, model input/output tokens, and tool calls.
Keep estimated cost distinct from billed cost and infrastructure errors distinct
from model failures. Use the matched Keeled reference for causal comparison;
the public leaderboard is an external comparison with documented setup differences.

## Restored allowance and Gemini comparison

The user raised the evaluation key cap to $75; a read-only check showed $25.023976587
remaining before resuming. Both reference and candidate now explicitly use
`openrouter/google/gemini-2.5-flash` as the simulator. GPT-4.1 is not used in future
runs. The previous incomplete held-out attempt remains invalid.

Run fresh reference and candidate screens on all tasks 0–9, then apply the user's
50-task expansion gate. The candidate includes the source-binding correction.
Source snapshots and hashes are under `reviews/queryable-context/gemini-screen/`.
The local Tau checkout is `b7ea9074c1cba482b30687fecdb5c8425fd6f619`, with only
Keeled bridge integration changes; its Airline base split contains 50 tasks.
Dataset and policy hashes are saved with the source snapshots. OpenRouter's exact
benchmark commit is not published on the inspected page, so identical task versions
cannot yet be asserted.

## Fresh Gemini ten-case comparison: expansion gate passed

Both runs finished all ten cases with Gemini 2.5 Flash as the simulator, one trial,
seed 300, concurrency 3, and the same generation and turn limits. The candidate
runtime matched its saved source hashes after completion. It includes the exact
observation-input binding correction. The reference retained its prior context and
tool surface while using the same completion-model route and usage diagnostics.

| Metric                           |       Reference | Updated candidate |
| -------------------------------- | --------------: | ----------------: |
| Task success                     |            8/10 |              9/10 |
| Mean task seconds                |          105.51 |             33.53 |
| Median task seconds              |           61.21 |             32.24 |
| p90 task seconds                 |          248.73 |             58.75 |
| LLM input tokens                 |       1,374,629 |         1,049,632 |
| LLM output tokens                |         183,091 |            42,966 |
| Controller input tokens          |       4,782,490 |         2,297,237 |
| Uncached agent-plus-Jev estimate |         $0.8330 |           $0.4629 |
| Known-cache-adjusted estimate    | $0.5904–$0.6102 |   $0.3316–$0.3423 |
| Missed reference writes          |               4 |                 3 |
| Writes unmatched to reference    |               1 |                 0 |
| Duplicate writes                 |               0 |                 0 |

Median latency improved 47.3%, estimated cost about 44%, and LLM input 23.6%,
with a higher observed task score. This passes the user's ten-case expansion gate.
Both runs issued one reference-typed write; the candidate's matched the reference.
This is not a claim that all requested write work succeeded: three expected writes
were missed, and one task failed. Estimates include Jev but exclude user simulation.
The reference has cache detail for 371 of 373 model calls; the candidate has it
for all 239 calls. Missing usage from timed-out work remains unknown.

Metrics are `gemini-reference-metrics.json` and `gemini-candidate-metrics.json`.
The user explicitly confirmed running all 50 tasks on the updated candidate.
The full run uses the same frozen source, with all 50 tasks run afresh rather than
combining the ten-case screen with another 40 cases. The OpenRouter comparison
will use the full run's score and per-task means, with configuration differences
and measurement limits stated explicitly.

## Updated full 50: improvement goal not established

The frozen candidate completed all 50 fresh tasks: **32/50 (64%)**, mean 49.23 s,
median 34.65 s, p90 87.95 s. No infrastructure failures invalidated the run.
Agent-plus-Jev cost is estimated at $2.0089–$2.0673 with known cache usage,
or $0.0402–$0.0413/task. Simulator cost ($0.1695) is separate.
LLM input was 6,020,154 tokens; output was 349,789. Jev input was 11,866,101.
The first ten tasks scored 8/10 on this rerun, versus 9/10 in the screen.

The [OpenRouter Airline leaderboard](https://openrouter.ai/benchmarks/tau2-bench-airline#tool-calls)
lists DeepSeek V4.1 Flash at 75.7%, about $0.018/task, and 4.0 minutes/task.
Our candidate was faster but scored lower and cost more. This is an external
comparison, not a controlled test: routing, reasoning settings, harness, trial
counts, and possibly dataset revision differ. Local cost is estimated, not billed.
There is no matched 50-task reference run, so broad improvement is unproved.

Of 49 expected reference writes, 34 were missed. There were 21 write attempts,
six unmatched to reference, and no duplicate writes. Reference matching alone
is not a full policy-safety assessment. There were four generation failures and
four runtime-error traces. All 15 context-query errors were TypeSafe/Jev HTTP 400
`max_tokens_exceeded`: four on task 14 (passed), eleven on task 15 (failed).
These were not OpenRouter spending-limit errors. They cannot explain all failures.

Compact evidence: `experiments/queryable-context/gemini-full50-metrics.json`.
External reference: `experiments/queryable-context/openrouter-comparison-reference.json`.
Raw results: `/Users/caseycollins/projects/tau2-bench/data/simulations/20260921_193337_airline_keeled_keeled_user_simulator_gemini-2.5-flash/results.json`.
Runtime snapshots and hashes: `reviews/queryable-context/gemini-screen/`.

## Subsequent change: bounded Jev fact-query batches

After preserving the full-50 run, fact queries now split candidate lists before
sending serialized requests above 24,000 UTF-8 bytes, including questions and
source metadata. This is a conservative payload heuristic, not TypeSafe's exact
token ceiling. A structured HTTP 400 `max_tokens_exceeded` response causes further
binary splitting. Requests run sequentially and honor cancellation. A single
oversized candidate still fails through the existing query fallback; its content
is not truncated. Unrelated errors are not retried.

Results retain candidate order and exact source provenance. Complete-scope
requirements are combined conservatively; a missing scope answer stays unknown.
Reported token usage is summed and rejected attempts are counted when recovery
succeeds. Rejected requests provide no token usage. If a later batch fails, usage
from earlier successful batches is not currently carried through the thrown error;
failed-query cost remains a measurement limitation. The 50-task measurements above
predate this change. Local tests do not prove live accuracy or performance gains.

### Live batching check: tasks 10–19

All ten cases completed on the frozen batching implementation with the same agent,
Gemini 2.5 Flash simulator, seed, concurrency, and limits. Reference values below
are the corresponding task subset of the previous full-50 run, not a new baseline.

| Metric                        | Before batching |   With batching |
| ----------------------------- | --------------: | --------------: |
| Success                       |            7/10 |            6/10 |
| Mean seconds                  |           59.97 |           83.54 |
| Median seconds                |           58.14 |           53.54 |
| p90 seconds                   |           93.32 |           92.90 |
| Known-cache-adjusted estimate | $0.4845–$0.4978 | $0.9382–$0.9578 |
| LLM input tokens              |       1,449,736 |       2,216,964 |
| Jev input tokens              |       2,830,336 |       8,921,262 |
| Context-query failures        |              15 |               0 |

The change recovered the observed query errors but did not meet the performance
goal. Task 14 passed both times; it now took 361.13 s versus 104.42 s, with 531
controller calls versus 35 and 104.18 s of query time versus 0.84 s. It also had
more turns and external calls. This is observed trajectory divergence, not proof
that batching alone caused every change. Task 15 still failed. One trial does not
establish accuracy differences, but these costs rule out claiming acceptance.

Evidence: `pre-batching-ten-metrics.json`, `jev-batching-ten-metrics.json` in
`experiments/queryable-context/`. Raw candidate results:
`/Users/caseycollins/projects/tau2-bench/data/simulations/20260921_195752_airline_keeled_keeled_user_simulator_gemini-2.5-flash/results.json`.
Runtime hashes under `reviews/queryable-context/jev-batching/` matched after the run.
Local validation: 129 tests passed, lint, formatting, type checking, and diff checks.

Next work must reduce repeated semantic judgment work without discarding provenance,
constraints, or exact source coverage. Batching is error recovery; it is not yet a
measured efficiency improvement. The overall reducer-state objective remains open.

## Query selectivity experiments after batching

A fixed-input live test used ten queries over two unrelated synthetic collections
(file records and inventory records), 48 candidates per query. Eight queries had
one exact target; two targets were absent. Modes alternated within the same run.
The fixtures are only evaluation data in `experiments/queryable-context/jev-layout.ts`.

Moving each candidate into structured question instructions, with only the query
in shared state, was **rejected**. All targets remained present, but the candidate
selected all 48 records on every query. Input rose from 183,885 to 336,230 tokens
(+82.8%); mean query time rose from 716 to 782 ms. Reference selection was also poor:
none of its ten selections exactly matched the expected set. The shared-state
layout was restored. Evidence: `jev-locality-rejected.json`.

The next candidate changes only generic relevance and contradiction wording. A
record for a different entity or scope, or an option failing a selection condition,
is not by itself evidence that a factual premise is false. Relevance must concern
the requested referents, governing rules, or complete comparisons. No domain keys,
tool names, or evaluator answers enter the runtime prompts.

On the same ten fixed queries, this candidate produced 9/10 exact selections
versus 0/10 for the saved reference. It retained all eight present targets and
returned empty selections for both absent targets. One query retained one extra
record. Input rose from 183,885 to 224,205 tokens (+21.9%), with mean query time
804 versus 817 ms. These are retrieval checks, not task-performance proof. Evidence:
`jev-scope-fixed-metrics.json`. The full ten agent cases 10–19 are being rerun before
judging total cost, speed, or accuracy.

The current [TypeSafe model documentation](https://docs.typesafe.ai/models) gives
64k tokens per request and 32k for state plus the longest question. The local byte
budget remains a heuristic; the exact served model version was not recorded.

### Scope-judgment agent check: all ten complete, acceptance failed

Tasks 10–19 completed with no infrastructure errors and unchanged runtime hashes.
The run scored **4/10**, versus 6/10 for batching alone and 7/10 in the earlier
full-run subset. Mean latency was 72.61 s; median 46.38 s; p90 112.61 s.
Known-cache-adjusted agent-plus-Jev cost was $0.5132–$0.5251. LLM input was
1,303,034 tokens and Jev input 4,073,454. There were zero context-query failures.

Only tasks 15 and 18 reached semantic fact selection (10 and 17 measured queries).
The other eight used the unchanged exact-small-scope path, so changes in their
outcomes are not evidence about the revised selection questions. Task 15 passed;
task 18 failed. This one trial fails the task-level acceptance gate and cannot
establish a causal performance improvement. The narrower judgment remains a
candidate supported by fixed-input selectivity checks, not an adopted performance
claim. A new full-50 run is not justified by this result.

A separate observed failure in task 14 illustrates an unresolved general mechanism:
a proposed write was blocked after authorization checks, but the final response
said it would now perform the action. The external write never happened. This is
not a retrieval failure: that task made no semantic fact queries in this run.
Permission checks must remain intact; response generation must reflect the actual
execution state and must not promise work after the turn has stopped.

Evidence: `experiments/queryable-context/jev-scope-ten-metrics.json` and raw results
`/Users/caseycollins/projects/tau2-bench/data/simulations/20260921_201210_airline_keeled_keeled_user_simulator_gemini-2.5-flash/results.json`.

## Response termination and execution-state diagnostics

The final response instructions now state that execution has stopped: a reply
cannot schedule tool work. Already scheduled background jobs may still be reported
when supported by a tool result. The input-needed guidance distinguishes policy
denial from missing evidence and exact confirmation. Core and bridge responses
use the same rule; authorization and execution gates are unchanged.

A live fixed-input check covered ten states across document and inventory tools:
denied writes, missing revisions, changed confirmation targets, completed writes,
and queued jobs. Both prompt versions accurately reported basic execution status
in these simple fixtures; the original false immediate-execution promise was not
reproduced. Mean response latency was 654 versus 690 ms; input tokens 6,055 versus
6,653; output 764 versus 986. Candidate replies still introduced some hypothetical
conditions and extra questions. This is not proof of improved task accuracy or
cost. Full replies and reported usage are in `response-stop-fixed-metrics.json`;
fixtures are `examples/tau-bridge/eval/fixed-responses.ts`.

Final bridge traces now include a `state` entry with the stop reason, retained task,
blockers (including exact proposed inputs and deciding reasons), and uncertain
operations. These diagnostics are not sent back as model context. A synthetic
regression across renamed write tools proves that a denied write produces no
external tool call and that its exact input and deciding reason reach the final
trace. Local checks: 130 tests, lint, formatting, type checking, and diff checks.

The same ten agent cases 10–19 are being rerun with this frozen implementation.

### Response-stop agent screen: all ten complete, acceptance failed

The frozen candidate scored **3/10** on tasks 10–19. Mean latency was 91.27 s,
median 63.79 s, p90 99.92 s. Task 18 took 427.67 s. Estimated known-cache-adjusted
agent-plus-Jev cost was $0.7774–$0.7944; LLM input was 2,098,754 tokens and Jev input
4,332,570. There were no context-query errors and no infrastructure failures.
This is worse than the preceding 4/10 screen and does not meet the acceptance gate.
Runtime hashes matched after completion. Metrics: `response-stop-ten-metrics.json`.
Raw results:
`/Users/caseycollins/projects/tau2-bench/data/simulations/20260921_202610_airline_keeled_keeled_user_simulator_gemini-2.5-flash/results.json`.

The new final-state trace exposed concrete, general failure mechanisms:

- In task 11, argument generation refused to fill a selected read tool because it
  judged that tool irrelevant, despite its supplied result schema supporting the
  needed lookup. It also introduced confirmation concerns for that read. Input
  resolution is mixing argument grounding with action selection and authorization.
- Task tracking retained identifiers and parameter selections as new independent
  goals, and accumulated paraphrases of an existing outcome. Completion then
  reported these details as unfinished requested outcomes.
- In task 14, an arithmetic-only call was held for confirmation. Tool risk remains
  supplied contract data; no tool-name exception or authorization bypass was added.
- In task 18, the runtime retried an earlier exact proposal using a previous value
  after the user supplied a replacement. The permission verifier denied it, so the
  safeguards prevented that stale action. The runtime currently revisits all
  unresolved held confirmations before normal action selection on each turn. This
  is a candidate cause of repeated obsolete work, not proof that all retries are
  invalid. Distinct pending user intents must remain possible.

Next changes should address those ownership and state-transition boundaries with
renamed synthetic tools and negative cases. The diagnostic addition is retained;
no broad performance gain is claimed for the response-prompt change.

## Argument binding ownership

Core and bridge argument prompts now share an explicit boundary: the controller
selects the tool, the resolver grounds its declared input fields, and the runtime
checks permission, confirmation, and repeat behavior. A lookup can be a prerequisite
to a larger requested effect. The resolver must not invent required values, add
fields absent from the schema, or substitute placeholders. A ready input is never
permission to execute. The resolver's duplicate-call prohibition was removed;
registered repeat semantics remain enforced by the runtime.

The first fixed-input run had underspecified write contracts: the schema accepted
only an ID, but the description and request did not define the intended change.
Its expected-ready labels were invalid. It is preserved as `binding-fixed-invalid.json`
and is not acceptance evidence. The corrected fixture gives writes explicit fixed
effects (archive a document or freeze an inventory record), still using only an ID.

All 12 corrected cases completed across document and inventory tools, covering
prerequisite lookups, pending confirmation, policy denial, missing IDs, ambiguous
IDs, and repeated reads. The reference bound or declined correctly in 8/12 cases;
the candidate in 11/12. Both declined all four genuinely missing/ambiguous cases.
A policy-denied action should still have grounded arguments in this isolated test;
actual execution remains forbidden by the unchanged authorization pipeline.
One candidate still confused policy denial with missing arguments.

Mean model-call latency fell from 494 to 378 ms (23.4%). Input rose from 6,178 to
7,651 tokens; output fell from 716 to 427. At the documented uncached agent rates,
cost rises about 3.5%. This narrow test does not establish whole-agent improvement.
Evidence: `binding-fixed-metrics.json`; fixtures: `examples/tau-bridge/eval/fixed-binding.ts`.
Local checks: 130 passing tests plus lint, format, type checking, and diff checks.
The full ten cases 10–19 are running on the frozen candidate before judgment.

### Argument-binding agent screen: all ten complete, gate still unmet

Tasks 10–19 scored **5/10**, versus 3/10 in the preceding response-stop screen and
7/10 in the earlier full-run subset. Mean latency was 62.42 s, median 52.62 s,
p90 87.04 s. Estimated known-cache-adjusted cost was $0.6352–$0.6497. LLM input was
1,641,339 tokens; Jev input was 4,680,331. There were no query or infrastructure
errors. The runtime matched its saved hashes. Evidence: `binding-ten-metrics.json`.
Raw results:
`/Users/caseycollins/projects/tau2-bench/data/simulations/20260921_204240_airline_keeled_keeled_user_simulator_gemini-2.5-flash/results.json`.

The change recovered some outcomes but does not meet the full acceptance gate.
The new traces also exposed a concrete retrieval omission: task 15's permission
verifier reported two scoped lookups as missing, although both tool calls had
returned exact empty arrays. Candidate ranking used result values only, so empty
observations had no lexical terms from their originating arguments. Successful
results were also absent from call history unless semantic selection retained them.

## Preserve compact results and retrieval scope

Candidate ranking now includes the source observation's exact tool and arguments.
Index signatures and query revisions include source role, authority, order, and
observation metadata, so a scope change invalidates cached judgments even when
result content is unchanged.

Decision call history now retains exact successful results whose JSON serialization
is at most 512 characters. This includes empty results, scalar values, and short
status records. Each stays beside its originating tool, arguments, and source ID.
Larger successful results are explicitly marked `resultOmitted`, and the context
rule distinguishes omission from an empty result. This can duplicate some small
selected records; it is a bounded tradeoff to avoid losing cheap, decisive evidence.
No business fields, tool-name rules, or evaluator answers enter the mechanism.

New synthetic tests cover renamed tools, rejection by semantic selection, empty
arrays and objects, false, zero, null, short queued-job results, large omissions,
and cache invalidation after observation scope changes. All 132 tests and local
quality checks passed. The full ten cases 10–19 are now running with this change.

### Compact-result agent screen: all ten complete, gate unmet

Tasks 10–19 scored **4/10**. Mean latency was 51.44 s, median 50.18 s, p90 76.06 s.
Estimated known-cache-adjusted agent-plus-Jev cost was $0.5098–$0.5224. LLM input
was 1,450,676 tokens; Jev input was 2,914,754. There were no context-query errors or
infrastructure failures, and runtime hashes matched after completion.

Task 15, which had previously lost two empty lookup results from its decision
context, passed this time. Its final blocker concerned an unfinished tracker goal,
not absent lookup results. This is useful target-boundary evidence alongside the
synthetic retention tests; one changed trajectory is not sole-cause proof.

Compared with the preceding argument-binding candidate, mean latency and cost
fell, but score also fell from 5/10 to 4/10. Compared with the earlier full-run
subset, score fell from 7/10 to 4/10, beyond the allowed regression. Do not select
a weaker intermediate candidate as the acceptance baseline. The overall gate is
unmet and a new full-50 expansion is not justified by this screen.

Metrics: `experiments/queryable-context/compact-results-ten-metrics.json`.
Raw results:
`/Users/caseycollins/projects/tau2-bench/data/simulations/20260921_205214_airline_keeled_keeled_user_simulator_gemini-2.5-flash/results.json`.
The compact-result fix is retained for correctness of the context view; broad
performance improvement remains unproved. All 132 local tests and quality checks
passed for this runtime.

### Explicit selection of held actions

Removed automatic replay of all held confirmations at the start of each turn.
The controller now selects an exact pending action, new arguments, or a response.
Jev receives exact resume choices alongside ordinary tools; selected inputs still
pass schema, availability, policy, and confirmation checks. Custom controllers
must select held inputs explicitly. Pending actions are not deleted by unrelated
conversation or by selecting a different action.

All 135 tests pass. The initial synthetic Jev screen selected exact inputs in
2/4 unchanged confirmations. Clarifying the ordinary-tool option increased this
to 4/4. Both screens avoided held calls for corrections, unrelated requests, and
withdrawals. The final strict selection score is 8/10: both corrected-target cases
ask for confirmation instead of selecting the ordinary tool, which is safe but
may add a turn. These are selection checks, not end-to-end accuracy or cost proof.
The first and final outputs are preserved as `selected-resume-first-metrics.json`
and `selected-resume-fixed-metrics.json` under `experiments/queryable-context`.
A frozen ten-case agent screen is the next gate; no broad improvement is claimed.

### Selected-resume agent screen: all ten complete, gate unmet

Tasks 10–19 scored **7/10**, equal to the earlier full-run subset. Mean latency
was 88.539 s (reference 59.9712 s), median 82.9605 s, and p90 150.154 s. Estimated
agent-plus-Jev cost with reported cache usage was $0.7065–$0.7212 (reference
$0.4845–$0.4978). LLM input was 1,750,339 tokens versus 1,449,736; Jev input was
5,142,190 versus 2,830,336. Accuracy recovered, but speed, cost, and context volume
all regressed. This does not meet the goal or justify expanding to 50 cases.

All ten were scored without infrastructure errors. No context-query errors were
reported; three generation failures occurred. Cache details were available for
272/274 model calls, so cost remains an estimate. Runtime hashes matched after
the run. Exact held inputs were selected nine times across six tasks, including
five writes in task 18. That task still failed because three payment targets
differed from the reference, despite completing all five changes and stating the
expected total. User dialogue changed the requested payment target; do not treat
reference mismatch alone as proof of a stale-action bug or alter code to force
reference targets.

Remaining failures were tasks 11, 17, and 18. Task 11 still has a resolver refusing
a read because multiple known identifiers must be inspected to locate the match;
the response also refused an otherwise supported alternative after the original
request was denied. These are general grounding/control issues, not evidence for
adding domain logic. Query work consumed about 21.4 s in task 14 and 27.0 s in
task 15; it was negligible in the other eight. Further cost work should inspect
repeated semantic judgments and source expansion without dropping required facts.

Metrics: `experiments/queryable-context/selected-resume-ten-metrics.json`.
Raw: `/Users/caseycollins/projects/tau2-bench/data/simulations/20260921_210843_airline_keeled_keeled_user_simulator_gemini-2.5-flash/results.json`.
