# τ³-bench bridge

Serves Keeled sessions over HTTP so an external harness can drive them turn by turn. The
bridge does not depend on any benchmark. The τ³-bench agent that calls it lives in the
τ³-bench checkout (`src/tau2/agent/keeled_agent.py`, registered as `keeled`).

## Who owns the tool loop

τ³-bench executes tools itself, and it has to:

- `src/tau2/orchestrator/orchestrator.py` (`step`): when the agent returns an
  `AssistantMessage` with `tool_calls`, the orchestrator routes it to `Role.ENV`, runs
  `environment.get_response(tool_call)`, appends the `ToolMessage` to the trajectory, and
  sends it back to the agent.
- `src/tau2/evaluator/evaluator_env.py` (`calculate_reward`): the predicted database is
  rebuilt with `Environment.set_state(message_history=full_trajectory)`, which **replays
  the tool calls recorded in the trajectory**. Action checks read the same trajectory.

A tool call must reach the benchmark trajectory so the evaluator can replay it.
The bridge pauses the turn at each external tool call. `Agent.run` runs a whole turn and
`@keeled/core` has no suspend/resume, so the pause lives in the bridge instead:

1. Each τ³ tool is registered as an `agentTool`. Keeled's controller selects it and the
   runtime resolves and validates its input exactly as for any other tool.
2. Its `execute` returns a promise the bridge holds open, and the bridge answers the pending
   HTTP request with the tool call.
3. τ³ executes the call and records it. The next request carries the `ToolMessage`, which
   resolves the held promise, and the unmodified loop continues.
4. When the controller chooses to respond, the turn ends and the text is returned.

The bridge uses the same core execution loop as other hosts.

## Session state

Each session is keyed by an id the caller supplies and holds only the persisted
`AgentMessage[]`. Execution state is derived from it by the core reducer on every turn.
Every event carries the controller decisions made since the previous event. The τ³ agent
stores them in `AssistantMessage.raw_data.keeled.decisions`, so they appear in the saved
trajectory.

The session also registers Keeled's `evidence` tool. It runs locally over stored results
and is never sent to τ³, so it can page or rank a large result, such as every connecting
flight by total business fare, without another environment call.

Tool input is generated with a schema that lets the model answer `missing` instead of
arguments; that becomes a `missing_evidence` blocker rather than invented values.

Tool input and the final response are generated with the whole conversation in view
(`resolveInput` and `respond` in `src/tools.ts`), because τ³ conversations span several
turns. The bridge also supplies the benchmark tool catalog and risk-specific argument models.

## Ready read calls

The bridge builds complete candidates for `get_reservation_details`, `get_user_details`,
and `get_flight_status` using explicit airline result mappings. A user result supplies its
reservation IDs; a reservation supplies its owner and paired flight/date records; flight
searches supply their returned flights. Connecting legs retain their own departure dates.
The search date is only a fallback for records without a date.

Each decision rebuilds the ready set from persisted tool history. Successful reads with
the same input are omitted within the current user turn. A successful mutation or an
unclassified tool invalidates earlier source records. These are conservative candidate
rules; ordinary tool selection and argument resolution remain available. Write calls
continue to use the existing resolver and authorization flow.

## Endpoints

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `PUT` | `/sessions/:id` | `{ instructions, tools, history? }` | `201` |
| `POST` | `/sessions/:id/user` | `{ text }` | event |
| `POST` | `/sessions/:id/tool` | `{ id, content, error? }` | event |
| `DELETE` | `/sessions/:id` | | `204` |

An event is `{ type: 'tool_call', id, name, arguments, decisions }` or
`{ type: 'message', text, stopReason, usage, decisions }`.

## Running a domain

```sh
bun run tau3 mock
bun run tau3 airline --num-tasks 5
bun run tau3 airline --task-ids 0 1 2 --max-concurrency 1
```

`tau3` starts the bridge, runs `tau2 run --domain <domain> --agent keeled` in the τ³-bench
checkout, and stops the bridge. Any other `tau2 run` option passes through. `mock` and
`airline` are tested; other domains run with a warning. The default is **one trial per task**;
keep screening runs at one trial until a promising change warrants a larger evaluation.

| Variable | Where | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | Keeled `.env` | Jev controller |
| `OPENROUTER_API_KEY` | Keeled `.env` | Keeled's model calls |
| `KEELED_MODEL` | Keeled `.env` | OpenRouter model id, e.g. `anthropic/claude-sonnet-4.5` |
| `OPENROUTER_PROVIDERS` | optional | Provider order, default `together,modal`; no fallback beyond the list |
| `OPENROUTER_API_KEY` | τ³-bench `.env` | User simulator |
| `TAU2_USER_LLM` | optional | User simulator model, default `openrouter/openai/gpt-4.1` |
| `TAU2_DIR` | optional | τ³-bench checkout, default `~/projects/tau2-bench` |

The two key sets stay separate. τ³-bench never overrides variables already in its
environment, so the runner withholds Keeled's credentials from it and it reads only its
own `.env`.

Results land in the checkout's `data/simulations/`; view them with
`.venv/bin/tau2 view` from the checkout. `--agent-llm` is ignored by this agent.

OpenRouter routing is pinned with `provider: { order, allow_fallbacks: false, require_parameters: true }`,
so requests go only to the listed providers, in order, and never to one that would drop
`response_format`.

Structured tool input is requested with `strictJsonSchema: false`, because τ³ tool schemas
use optional fields and open objects (`$defs`, `anyOf` with `additionalProperties`) that
strict mode rejects.

## Simplified-loop screen

Airline tasks 0–9, one trial per task, seed 300, concurrency 3, 300-second timeout,
zero retries. Agent: DeepSeek v4.1 Flash via Together/Modal; user: GPT-4.1.

| Version | Successes | Mean seconds/task |
| --- | ---: | ---: |
| PR #5 (`f31c283`) | 9/10 | 121.4 |
| Simplified loop (`4527d35`) | 8/10 | 62.2 |

Both runs had zero errors and timeouts. This single screen shows a speed/accuracy tradeoff,
not an established improvement. Both failed task 7; the simplified loop also failed task 8
with repeated reservation lookups and no booking. Structured model calls were 335 versus
350, so removing planning did not eliminate argument-resolution loops. The production
source in this PR matches the tested simplified loop. Raw experiment files are excluded
from the PR; the runner above remains available for future screens.

## Ready-call screen

The read-call candidate experiment used the same tasks 0–9 and settings as the simplified
loop screen above. Only the updated code was run; the baseline is the saved
`keeled_codex_simple_single_20260919/results.json` data.

| Version | Successes | Mean seconds/task | Structured generation calls |
| --- | ---: | ---: | ---: |
| Saved simplified loop | 8/10 | 62.2 | 350 |
| Ready read calls | 9/10 | 33.0 | 36 |

Jev selected 34 stored calls: 29 reservation lookups, one user lookup, and four flight-status
checks. Task 8 now passed; task 7 still failed the upgrade/cancellation flow and cost total.
Both screens had zero simulation errors or timeouts. This is one trial per task, so it does
not establish a general accuracy or latency improvement. Generation counts include more
than argument filling; changed trajectories also contribute to the reduction.

## Full 50-task ready-call run

With the same candidate code and settings, all 50 airline tasks were run once:
**34/50 passed (68%)**, with 10 ordinary failures, five empty-message infrastructure
errors, and one timeout. Tasks 0–9 again passed 9/10; tasks 10–49 passed 25/40.
Jev selected 150 stored calls across the saved trajectories.

The empty-message errors occurred on tasks 16, 21, 24, 25, and 35. An offline reproduction
shows that a `TimeoutError` can be treated as cancellation and return empty text, which the
bridge forwards and the benchmark rejects. Lost error trajectories prevent confirming
that cause for every live failure. Task 23 separately timed out.

The older saved full run (`keeled_airline_50_v2`) scored 36/50, but does not record its agent
model or exact agent source, so it is not a matched baseline. The full result does not yet
establish a general accuracy gain. Error rows also lose duration and usage data, preventing
a clean total-latency or cost comparison. No runtime changes were made during this run.


## Generic harness changes after the snapshot

The snapshot results above predate the current changes and do not measure them.
Sessions now use the reusable task tracker and evidence calculation tool. Tests can disable
the tracker with `trackTasks: false`. No new airline policy, pricing, or ownership rules
were added to the framework.

`Session` accepts a trusted `access` adapter from its host. The stock loopback HTTP server
does not authenticate benchmark users or supply this adapter, so mutations now fail
closed. The runner is therefore not yet configured for a comparable write-enabled run.
Before another benchmark, integrate a trusted identity and authoritative resource access
adapter in the host. A user ID in a simulated conversation is not sufficient authorization.
HTTP request bodies cannot configure access or disable the task tracker.
