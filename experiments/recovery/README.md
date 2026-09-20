# Experiment 3: one-call stall recovery

This experiment adds optional `recovery` to `createAgent`. It is off by default.
The tested configuration was rejected: 8/10 successes versus a saved 9/10 baseline,
with 24 recovery calls. Read the [results](RESULTS.md) before enabling or extending it.

```ts
const agent = createAgent({
  instructions,
  tools,
  model: responseModel,
  argumentsModel: fastModel,
  controller,
  recovery: { model: reasoningModel, maxAttemptsPerRevision: 1 },
});
```

The existing loop guard can trigger recovery. A blocked controller response can also trigger it. A needs-input response triggers it only after input-resolution, missing-evidence, or no-progress blockers. Normal completed responses and ordinary initial questions do not trigger recovery.

Recovery receives the retained request, instructions, goals and constraints, tool history, blockers, uncertain writes, and current tool schemas. It returns one call, one missing-information question, or a blocker. The prompt requires a lookup before asking for information available through tools. This is model guidance, not a deterministic proof that a question is necessary.

The runtime persists an allowance key before generation and charges one work step. A proposed call costs another work step and uses the existing schema validation, risk policy, inspection, authorization, confirmation, duplicate checks, and uncertain-write quarantine. SDK retries are disabled for recovery. Invalid responses consume the allowance. Generation call totals include failed attempts. Failed provider calls can still lack billable token counts.

The key includes the request, instructions, retained goal text/status, and constraints. It deliberately excludes observations and errors. This conservative rule stops unrelated results from reopening recovery, but also means a useful lookup alone does not grant another attempt. It does not implement Experiment 1's more precise dependency revisions.

The bridge enables this option with `KEELED_RECOVERY_MODEL`. It uses the existing provider list and low reasoning effort. No domain names, tool-name rules, or benchmark answer logic were added to the runtime or bridge.

Recovery decisions use a strict Zod discriminated union; `RecoveryDecision` is inferred from that schema. Zod-based tool contracts keep their own validators, refinements, and transforms. Raw JSON Schema contracts without a validator are checked with Ajv and standard format validation. This closes a pre-existing SDK fallback that accepted inputs without checking the JSON Schema. We do not convert those contracts to Zod because its converter rejects standard conditional constraints such as `if`/`then`.

The synthetic tests cover renamed lookup tools, missing dependencies, invalid arguments, unavailable tools, policy denial, confirmation, unknown write outcomes, transient reads, repeated decisions, persisted allowance, unrelated observations, ordinary discovery, missing user information, and budget exhaustion.

For the airline screen:

```sh
bun --env-file=/Users/caseycollins/projects/tau2-bench/.env run tau3 airline \
  --task-ids 0 1 2 3 4 5 6 7 8 9 --num-trials 1 --seed 300 \
  --max-concurrency 3 --timeout 300 --max-retries 0 \
  --save-to /absolute/path/to/results
```

Set `KEELED_RECOVERY_MODEL` to the desired OpenRouter model ID in the environment. The recorded screen used `deepseek/deepseek-v4.1-flash` for both the existing model and recovery, routed through Together/Modal. Raw results remain local and are ignored by Git. `analyze.py` computes the report from the recorded results and a saved baseline. See `RESULTS.md` for results and limitations.
