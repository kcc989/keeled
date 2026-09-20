# Joint tool and argument generation: first screen

Date: 2026-09-20. Decision: **keep opt-in; do not make this the default**.

The joint controller passed 9 of the first 10 airline cases. This is better than
the saved historical reference's 8/10, but it was slower, cost more per success,
timed out on case 7, issued one duplicate write attempt, and rejected 36 malformed
controller outputs. One single-trial screen against an older reference does not
justify adoption.

## Implementation

The opt-in controller asks the configured decision model for one native tool call.
Application tools use their registered descriptions and input schemas. Three
reserved response tools represent completed, needs-input, and blocked outcomes.
The model has no execution callbacks.

A complete call enters the existing prepared-input path. The runtime still checks
current availability, schema validation and transforms, repeat rules, policy,
inspection, Jev authorization, confirmation, and unknown write outcomes. A held
confirmation resumes its exact input. Existing tool-only controllers retain split
argument generation.

Joint mode rejects configurations with custom resolvers or per-tool model overrides.
The Tau switch registers the same external tool contracts without its custom split
resolver. Run it with:

```bash
bun run tau3:first airline 10 --keeled-controller joint
```

The implementation also fixes an independent shared validation gap. Raw JSON Schema
contracts now use AJV at execution. Zod contracts still use their validators,
refinements, and transforms. Both controller paths use this validation.

## Source and configuration

- Keeled base: `dbe65b97c771347eb5000e0fd7290fe44c7d7f80`.
- Uncommitted implementation patch digest before this report:
  `466a3c0bf4dae3e23a67993c719784d78dbac580`.
- Tau checkout commit recorded in the result: `b7ea9074c1cba482b30687fecdb5c8425fd6f619`.
- Result: `data/simulations/keeled_joint_first10_20260920/results.json` in the
  Tau checkout.
- Tasks: airline IDs 0-9, one trial, seed 300, concurrency 3, 200 benchmark
  steps, 300-second task timeout, zero automatic retries.
- Agent, decision, tracker, completion, and response model:
  `deepseek/deepseek-v4.1-flash` through Together then Modal. Read-style model
  calls disabled reasoning; other model calls retained their existing settings.
- User simulator: `openrouter/openai/gpt-4.1`.
- Authorizer: the unchanged Jev controller; its resolved model version was not
  captured.
- Runtime generation timeout: 60 seconds. Runtime turn timeout: 240 seconds.

## Results

| Metric                                         | Saved historical reference | Joint candidate |
| ---------------------------------------------- | -------------------------: | --------------: |
| Task success                                   |                       8/10 |            9/10 |
| Timeouts                                       |                          0 |               1 |
| Median task latency                            |                     53.6 s |         100.7 s |
| p90 task latency, nearest rank                 |                    106.4 s |         149.8 s |
| Mean task latency                              |                     62.2 s |         119.7 s |
| Selection attempts                             |                        401 |             228 |
| Accepted joint decisions                       |                        n/a |             192 |
| All recorded model generation attempts         |                        421 |             406 |
| Failed model generations                       |                          0 |               4 |
| External tool calls                            |                         39 |              78 |
| Rejected controller outputs                    |               not recorded |              36 |
| Issued state-changing calls                    |                          1 |               3 |
| Successful matching state changes              |                          1 |               2 |
| Duplicate state-changing attempts              |                          0 |               1 |
| Missed reference writes                        |                          3 |               2 |
| Estimated agent plus Jev cost per success      |                    $0.0985 |         $0.1210 |
| Estimated cost per success including simulator |                    $0.1174 |         $0.1360 |

The historical reference is
`keeled_codex_simple_single_20260919/results.json`. Task IDs, seed, model aliases,
and benchmark step budget match. The Keeled source revision, raw-schema validation,
run date, and live provider conditions differ. It is context, not a paired baseline,
and the table does not establish that joint generation caused the score change.

Latency includes the 329.3-second timeout. The nine completed cases had 96.4-second
mean latency. The trace recorded 406 generation attempts: 228 joint decisions, 63
task extractions, 62 responses, 27 permission checks, and 26 completion checks.
Four generations failed: three task-extraction parse failures and one completion
timeout. Trace totals were 2,818,716 input tokens and 188,300 output tokens. The
timeout ended before final turn accounting, so completed-turn usage reported only
397 calls and fewer tokens.

Cost uses the recorded trace tokens, $0.30/$1.20 per million input/output tokens
for the pinned Together and Modal routes, and $0.042 per million Jev input tokens.
It is an uncached list-price estimate, not an invoice. Failed calls can lack usage.
The rates were checked on the report date at
[OpenRouter](https://openrouter.ai/deepseek/deepseek-v4.1-flash) and
[TypeSafe](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

## Failure and safety review

Case 7 timed out after 329.3 seconds. It made the expected cabin upgrade with the
reference arguments, then missed both expected cancellations and did not report the
required $1,628 total for the user's other upcoming flights. The timeout result has
no evaluator DB check, so its partial work is reported from the saved tool trace.

Case 8 made the expected booking successfully, then issued the exact booking again.
The second call failed with `Not enough seats on flight HAT271`. The final database
still matched and no second booking was applied, but the runtime correctly marked
the failed write outcome as unknown. This is one duplicate write attempt and a
safety regression that aggregate reward hides.

Of the 36 rejected controller outputs, 20 contained two to nine tool calls and 16
had invalid response-tool input. The runtime rejected every one and charged bounded
work before another normal controller cycle. There was no hidden repair request.
All accepted external calls passed the normal runtime path. Among the nine evaluated
completions, the evaluator recorded 19/19 expected reads and 1/1 expected write.
Across the complete trace, no applied write used arguments outside the reference,
but only two successful state changes were observed.

## Decision

Keep the controller experimental and opt-in. The score is encouraging, especially
the successful case-8 booking, but the timeout, duplicate write attempt, malformed
decision rate, higher cost, and higher latency fail the adoption bar. Do not change
the default controller.

A later evaluation should first reduce invalid multi-call output without silently
executing a subset or adding a hidden repair ladder. Then run paired repeated and
held-out tasks with frozen source, model routes, budgets, full failed-work telemetry,
and explicit review of every write and premature stop.
