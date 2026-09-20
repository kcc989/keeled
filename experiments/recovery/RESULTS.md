# Experiment 3 result: reject this configuration

The corrected recovery candidate passed **8/10** airline cases. The saved historical baseline passed **9/10**. No case that failed in the baseline became a success. Case 8 regressed. Recovery was called 24 times across 10 cases, including cases that ended in valid policy refusals. This does not justify adopting the configuration. Only documentation and metrics are retained; the implementation and independent validation fix require separate review.

| Metric                                    | Saved baseline | Corrected recovery candidate |
| ----------------------------------------- | -------------: | ---------------------------: |
| Successful cases                          |           9/10 |                         8/10 |
| Recovery generations                      |              0 |                           24 |
| Recovery generations per case             |              0 |                          2.4 |
| Model generations, including recovery     |            408 |                          374 |
| Recorded controller calls                 |            649 |                          296 |
| Median task latency                       |         98.0 s |                       83.0 s |
| p90 task latency, nearest rank            |        242.9 s |                      148.3 s |
| Mean task latency                         |        121.4 s |                       99.7 s |
| Estimated recorded agent + user cost      |        $1.4053 |                      $0.9721 |
| Estimated recorded cost / successful case |        $0.1561 |                      $0.1215 |
| Missed reference writes                   |              2 |                            3 |

Lower recorded cost and latency do not establish an improvement: success fell, these are single trials, and the baseline is historical rather than a paired run of this checkout. All recorded failed decisions and recovery generations within each retained simulation are included. Missing billing data and earlier experiment work are discussed below.

## Cases

| Case | Baseline | Candidate | Latency | Recovery calls | Missed reference writes |
| ---- | -------- | --------- | ------: | -------------: | ----------------------: |
| 0    | Pass     | Pass      |  37.7 s |              2 |                       0 |
| 1    | Pass     | Pass      | 289.4 s |              3 |                       0 |
| 2    | Pass     | Pass      |  52.2 s |              4 |                       0 |
| 3    | Pass     | Pass      |  75.9 s |              0 |                       0 |
| 4    | Pass     | Pass      |  90.1 s |              2 |                       0 |
| 5    | Pass     | Pass      | 109.2 s |              4 |                       0 |
| 6    | Pass     | Pass      |  50.0 s |              1 |                       0 |
| 7    | Fail     | Fail      | 148.3 s |              3 |                       2 |
| 8    | Pass     | Fail      | 119.6 s |              3 |                       1 |
| 9    | Pass     | Pass      |  24.7 s |              2 |                       0 |

Case 7 cancelled one reservation but did not perform the other required change and cancellation. It also omitted the required total. Case 8 inspected some reservations, then asked for a reservation ID instead of finishing the available lookups. It did not search for or book the requested flight. Recovery did not resolve that missing dependency.

The corrected candidate issued one database-changing call: a cancellation that matched the reference action. No incorrect database write was observed. Three reference writes were missed. This is limited safety evidence: only one write executed, and ten cases cannot establish absence of incorrect writes in general. The database mismatches on cases 7 and 8 reflect unfinished work, not proof of a new wrong write.

Recovery ran in 9/10 cases. The ledger prevents repeated attempts for the same key, but new user turns change the request key and can allow another call for a broadly similar unresolved goal. Recovery also ran before policy-refusal responses. This trigger is too broad for the intended occasional escape path. A quantified stall-detection error rate is not available because the traces lack independently labelled stall ground truth. The synthetic tests establish the guard behavior, not semantic stall-detection accuracy.

## Configuration and artifacts

- Keeled starting commit: `800328a`, with the local experiment changes.
- Task IDs: 0–9; one trial; runner seed 300; user simulator `openrouter/openai/gpt-4.1`.
- Candidate model and recovery model: `deepseek/deepseek-v4.1-flash`, routed through Together/Modal. Recovery uses low reasoning effort and zero SDK retries.
- Corrected run: concurrency 3, configured task timeout 300 seconds, zero benchmark retries. Runtime budgets remain 30 steps, 60-second generation timeout, and 240-second turn timeout.
- Baseline: `/Users/caseycollins/projects/tau2-bench/data/simulations/keeled_codex_baseline_single_20260919/results.json`.
- Corrected raw results: `airline-10-validated/results.json` and `airline-10-validated/run.log`.
- Earlier screen: `airline-10/results.json`, `airline-10/initial-run.log`, and `airline-10/resumed-run.log`.
- Recomputed metrics: `summary.json`. The analysis script and prototype are preserved in historical commit `8aff42c4a0131e97808c2053413514a83cbc95aa`; they are not in the current tree. Recomputing the metrics requires that historical script and the local raw results.

Raw artifacts are local and ignored by Git. The compact report and metrics remain reviewable. Other benchmark processes were active during this work, so provider contention can affect latency.

The Zod follow-up during the corrected run changed the recovery envelope's final parser to reject extra keys and inferred its TypeScript type from the schema. The running bridge had loaded the preceding parser. Both produce identical model-facing JSON Schema; the final strict-parser behavior is covered by local tests, not a separate third benchmark run. `source-hashes.json` records the final reviewed source, not a claim that the running process hot-reloaded it.

## Earlier work and cost limits

The first screen exposed a real input-validation gap: the SDK accepts plain JSON Schema inputs without validation when no validator callback exists. Case 8 sent null arguments to an object tool and failed at the benchmark boundary. The fix adds JSON Schema validation to the ordinary execution path; Zod tool validators keep their refinements and transforms. The corrected comparison therefore includes this general safety fix as well as optional recovery.

The earlier screen ended at **7/10**, with 27 recovery calls, one infrastructure failure, and one timeout. Its estimated recorded cost was **$0.8190**. The timeout was recorded at 396.8 seconds because the host checks its task timeout between calls; it is not a hard deadline for an in-flight request.

Before that screen resumed, case 1 was interrupted after more than 321 seconds because the initial command omitted a task timeout. Case 0 was retained, and the remaining cases resumed with concurrency 3 and a 300-second timeout. The interrupted attempt's tokens and partial trajectory were not saved. The infrastructure-failure artifact also has no partial messages or useful elapsed-time record.

Total recorded cost across both completed screens is approximately **$1.7911**, plus the unmeasured interrupted work and any unreported failed-call charges. There were 20 recorded case attempts plus the interrupted case-1 attempt. This missing telemetry prevents an exact total experiment cost or a complete cost-per-success claim. It is not treated as zero cost.

Cost estimates use uncached list rates of $0.30/M input and $1.20/M output for Together/Modal, plus $0.042/M Jev input and recorded simulator charges. Sources checked during this run: [OpenRouter provider pricing](https://openrouter.ai/deepseek/deepseek-v4.1-flash) and [TypeSafe pricing](https://typesafe.ai/blog/introducing-system-one-models-and-jev). These are estimates, not invoices. Failed generations can lack token usage, and a turn that never returns its final event can lack controller usage. The corrected run recorded one failed task-extraction generation. Recovery generation counts include failures; no failed recovery generation was recorded in the corrected run.

## Validation and decision

At the end of the experiment, `bun run check` passed: lint, formatting, TypeScript, and **114 tests**. The tests cover switched and renamed tools, missing dependencies, transient reads, missing user information, invalid proposals, JSON Schema validation, Zod transforms/refinements, policy denial, confirmation, unknown writes, budget accounting, and persisted recovery allowance. Runtime and bridge changes contain no airline-specific rules.

This is a first-10 screen, not the complete acceptance evaluation. Experiments 1 and 2 were not combined, held-out tasks were not repeated, and a plain LLM controller under the same safeguards was not run. The earlier unsafe prototype is not a repeat trial of the corrected implementation. Given the success regression and broad trigger, further acceptance testing is not warranted for this configuration. Do not adopt this configuration. The current tree contains only the historical documentation and metrics.
