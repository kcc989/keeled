# τ³-bench integration: what we tried and what we learned

This records the work on this branch: connecting Keeled to τ³-bench, then improving the
harness against it. It is written for whoever continues it, including the reasoning behind
each change and the measurements that motivated it.

## Goal

Run Keeled on τ³-bench (`sierra-research/tau2-bench`) to prove the integration, then use the
airline domain to make Keeled accurate **and fast**. Speed matters as much as score: the
point of the harness is that Jev, a fast classifier, selects actions while language models
only generate.

## Integration

**Who owns the tool loop.** τ³ executes tools itself (`orchestrator.py`), and its evaluator
rebuilds the database by replaying the tool calls recorded in the trajectory
(`evaluator_env.py`). A tool run inside Keeled would be invisible to scoring. `Agent.run`
cannot pause mid-turn, so the bridge does it: each τ³ tool is an `agentTool` whose `execute`
returns a promise the bridge holds open while τ³ executes the call and sends the result back.
Keeled's loop runs unmodified.

**Pieces.**
- `examples/tau-bridge`: the HTTP bridge (`server.ts`, `session.ts`, `tools.ts`), the
  runner (`bun run tau3 <domain> [tau2 options]`), and OpenRouter model setup (`models.ts`).
  It imports nothing from τ³.
- In the τ³ checkout (not in this repo): `src/tau2/agent/keeled_agent.py`, a
  standard-library shim registered as `keeled` in `src/tau2/registry.py`. It sends tool
  schemas, return schemas, risk, and repeat metadata (`READ` tools → `reuse`), and stores
  Jev's decisions and per-call timings in each message's `raw_data.keeled`.
- Models go through OpenRouter pinned to Together, then Modal, with no other fallback.
  Read arguments use reasoning off; write arguments use low effort.

**Environment notes.** τ³ `main` needs `websockets` even without the voice extra; install it
alone and run `.venv/bin/tau2` (a plain `uv run` re-syncs it away). `bun.lock` is version 2;
use `bunx bun@latest install`, as bun 1.2/1.3 downgrade it. Keeled and τ³ keep separate
`.env` files, and the runner withholds Keeled's credentials from τ³.

## What changed, and why

Each item was driven by a failure seen in a trajectory, not by speculation.

| Problem seen | Change |
| --- | --- |
| Action selection and progress assessment could disagree | One Jev `control` operation selects one action for the runtime-owned current plan step; `step:complete` crosses it off |
| Argument calls took 13.7 s spending reasoning tokens on extraction | Reasoning off for read arguments (0.3 s) |
| Replies retracted true statements in later turns | Reply and argument prompts see tool results from every turn |
| `get_users` never chosen; replies denied having tools | Tool descriptions include return shapes; reply prompt lists the tools |
| Tools repeated 30–90 times | Call history with arguments for Jev; factual repetition notes; opt-in `repeat: 'reuse'` for read tools; `poll` for tools meant to repeat |
| Fields past a fixed character cut (for example `reservations`) never reached Jev or the models | Full results, paged as complete records with stated omissions; `evidence` tool to read or sort any stored result |
| Policy-violating cancellation | `authorize` before writes: Jev judges permitted, needs verification, confirmed; a reasoning model decides when Jev is unsure; thresholds configurable; `unknown` risk included |
| Blocked writes retried | Structured blockers with a kind and a resolution; confirmation withdraws the tool for the turn; refusals remembered against the evidence they cited |
| Tool-call markup sent to users | Reply contract check with one repair and a status fallback; optional `reviewReply` |
| Duplicate call history entries | History keyed by call id |
| Plans were replaced too often, then never selected from a crowded action menu | Every task gets an implicit plan; the setup control request includes a focused `requires_plan` judgment, while normal cycles only advance the current step and recovery offers one revision |

The user's own changes on this branch added input-aware loop detection, evidence-aware
recovery, durable confirmations, read/write/planning guidance for Jev, and low-effort
reasoning for write arguments.

## Results so far

| Run | Airline score | Average time | Notes |
| --- | --- | --- | --- |
| Reference, before the second review | 0.72 (50 tasks) | | |
| `full_gemini` | 0.62 (50 tasks) | 68.7 s | |
| `harness_v3` | 0.64 (50 tasks) | 122.5 s | read-action match 92.3%, write-action match 46.9% |

Mock scores 0.80, its maximum: two mock tasks cannot be won as written (a COMMUNICATE string
no agent would say; a database check that contradicts its own environment assertion).

Single trials on ten tasks swung from 0.60 to 0.90 with near-identical code. **Compare
changes with several trials per task.**

## Where the time goes

In both 50-task runs, 91–95% of wall time is the agent. Jev is about 13% (about 240 ms per
decision). The rest is language-model calls: replies with reasoning (34–56%), structured
calls with reasoning (18–28%), and argument generation. In `harness_v3`, **76% of decisions
produced neither a call nor a reply**: mostly `get_reservation_details` chosen without the
means to name which reservation, followed by duplicate or missing-argument cycles.

## Jev argument selection experiments

The idea was to let Jev choose tool arguments from established facts instead of a model
generating them, with an explicit way out when no fact fits. The experiments replayed the
two 50-task runs: at each of 433 recorded calls, the fact index was rebuilt from what was
seen before it and sent to the real Jev service.

- **Coverage.** 76% of all argument values, and 86% of write values, appear verbatim in an
  earlier tool result under a matching key; 12% come from the user's words; 8% are computed.
- **The way out works.** When the right value is not in the index, Jev abstains 95% of the
  time (100% for writes). Each parameter has a "none" option and a separate "is it listed?"
  gate, and a value is used only when both agree with enough confidence.
- **Values mode** (one choice per parameter): right 56%, wrong 15%. Wrong picks are
  confident role errors, such as a return leg's origin or the other flight's date.
  Jev-then-model on writes reaches 87% against the model's 96%.
- **Records mode** (choose a whole record for parameters that belong together): wrong picks
  fall to 6% (flight changes 0%), but Jev mostly abstains. It declined 56 of 72 flight
  changes where the right record was offered, because nothing said which flight the user had
  chosen. Jev-then-model on writes: 94%.
- **Load.** One request per call, one per parameter, and one per parameter with a slim state
  gave the same accuracy and latency. Packing independent questions is free; split requests
  only when one answer depends on another.
- **Request ledger** (removed): one fast model call per user message
  records goals and slots, the values the user asked for or chose, with roles and
  derivations, such as resolving "the ATL to PHL flight" to reservation `M05KNL`. Updates take
  1.7 s median (p90 4.1 s) over a bounded window. **It did not help:** writes reached 92%
  with Jev-then-model, against 94% for records and 96% for the model alone. Flight changes
  stayed 100% abstentions, and payment choices got worse (43% wrong against 21%), because
  extra slot candidates were plausible but wrong. Reference write values were among the
  slots only 50% of the time.

| Mode | All arguments: right / wrong / abstain | Writes: Jev then model |
| --- | --- | --- |
| Values | 50% / 14% / 36% | 87% |
| Records | 30% / 6% / 64% | 94% |
| Ledger | 29% / 6% / 64% | 92% |

**Conclusion.** Jev does not yet beat the model at filling arguments (96% on writes). What
did work: it is reliable on unambiguous arguments (`user_id` 78 of 78), it declines when no
fact fits, and records remove role errors. The remaining gap is knowing which option the
user wants, which the ledger at 50% coverage did not close.

## What remains after the argument work

The active argument-selection and ledger implementations were removed. They added latency
and public API surface without beating the argument model. These results remain here so the
same design is not repeated without new evidence.

1. **Replies are drafted without reasoning;** a repair, triggered by the contract check or
   `reviewReply`, uses the reasoning model (`respondWith`). Replies were 34–56% of agent time.
2. **Jev sees each tool's readiness:** for every required parameter, the known values with
   labels and whether this tool already used them this turn, or that no value is known yet
   (`readinessNote` in `packages/jev/src/history.ts`, using `AvailableTool.required`). This
   targets decisions that led nowhere, 76% of decisions in `harness_v3`.

## Mistakes to avoid repeating

- Elapsed time must come from real timestamps: process elapsed time, recorded durations, or
  trajectory timestamps. A terminal read returns when output appears, so summing its maximum
  waits overstates time badly. Doing so here led to stopping a healthy run.
- A fixed character cut on tool results silently drops trailing fields; present results by
  structure instead.
- One trial per task cannot distinguish a change from noise.

## Next steps

1. Measure the two retained changes with several trials on a fixed task subset, reporting
   score, time, and the share of decisions that produce nothing.
2. Test whether the readiness context improves Jev's action choices.
3. Measure durable plans across multi-turn tasks and inspect when runtime recovery makes replanning useful.

## Reproducing

```sh
bun run tau3 airline --task-ids 0 1 2 --save-to my_run
```
