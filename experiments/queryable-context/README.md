# Queryable context evaluation

Current status: the updated Gemini-simulator full run scored 32/50. The preceding
matched ten-case screen showed lower latency, cost, and LLM input, but broad
improvement remains unproved. Subsequent ten-case screens on tasks 10–19 scored
6/10 (batching), 4/10 (narrower relevance), 3/10 (response-stop guidance), 5/10
(argument binding), and 4/10 (compact-result retention), against 7/10 in the prior
full-run subset. The overall acceptance gate remains unmet. The latest screen had
no query errors, mean latency 51.44 seconds, and estimated cost $0.5098–$0.5224.
See the validation report for scope, snapshots, fixed-input checks, and failures.
Historical simulator and credit-blocked results remain preserved with their limits.

The default catalog architecture is implemented. Its first ten-case screen failed
acceptance; its results remain in `pilot-metrics.json`. The historical reference is
in `historical-reference.json`. The revised full screen is in `second-metrics.json`; the controlled two-setting
comparison is in `fixed-state-results.json`. Neither candidate meets the agreed
acceptance criteria. None of these screens establishes broad proof.

`third-metrics.json` records exact small-scope context (9/10, latency regression).
`fourth-metrics.json` adds a non-reasoning completion model (8/10, lower median
latency and estimated cost, higher p90 latency). Its gains cannot be attributed
to context alone. Full traces and source snapshots remain preserved locally.

See [the validation report](../../docs/queryable-context-validation.md) for settings,
limitations, prices, and the current candidate. Extract compact metrics with:

```sh
python3 experiments/queryable-context/summarize.py /path/to/results.json
```

The script reads saved trajectories. It does not change execution, infer tool risk
from names, or turn missing telemetry into zero cost. It uses evaluator-supplied
write classifications for the limited reference-write comparison.

The fixed-state control can be reproduced with the same model configuration:

```sh
bun --env-file=/path/to/model.env run examples/tau-bridge/eval/fixed-context.ts /tmp/fixed-context.json
```

It makes 40 bounded LLM requests and up to 20 Jev query requests. It alternates modes,
keeps a stable full-history prefix, and records reported cache usage. The exported
raw result can contain per-request details; the committed result is a compact summary.

Selected held-action screen: `selected-resume-ten-metrics.json`, all ten cases
complete, 7/10, mean 88.539 s, estimated cost $0.7065–$0.7212. Accuracy matches
the earlier 7/10 subset but cost and latency exceed the allowed regression.
The generic confirmation behavior is covered by 135 passing tests; broad
performance improvement remains unproved. Synthetic choice results are recorded
in `selected-resume-first-metrics.json` and `selected-resume-fixed-metrics.json`;
see the validation report for the strict-score and safety distinctions.
