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
and is never sent to τ³, so it can page or rank a large result, such as every product bundle
by total component price, without another environment call.

Tool input is generated with a schema that lets the model answer `missing` instead of
arguments; that becomes a `missing_evidence` blocker rather than invented values.

Tool input and the final response are generated with the whole conversation in view
(`resolveInput` and `respond` in `src/tools.ts`), because τ³ conversations span several
turns. The bridge also supplies the benchmark tool catalog and risk-specific argument models.

## Endpoints

| Method   | Path                 | Body                                | Returns |
| -------- | -------------------- | ----------------------------------- | ------- |
| `PUT`    | `/sessions/:id`      | `{ instructions, tools, history? }` | `201`   |
| `POST`   | `/sessions/:id/user` | `{ text }`                          | event   |
| `POST`   | `/sessions/:id/tool` | `{ id, content, error? }`           | event   |
| `DELETE` | `/sessions/:id`      |                                     | `204`   |

An event is `{ type: 'tool_call', id, name, arguments, decisions, trace }` or
`{ type: 'message', text, stopReason, usage, decisions, trace }`.

## Running a domain

```sh
bun run tau3 mock
bun run tau3 <domain> --num-tasks 5
bun run tau3 <domain> --task-ids 0 1 2 --max-concurrency 1
bun run tau3:first airline 10
```

Select the opt-in joint tool-and-input controller without changing the default Jev path:

```bash
bun run tau3:first airline 10 --keeled-controller joint
```

Enable the opt-in Jev tool guide (see the [record](../../docs/experiments/tool-guide.md)):

```bash
bun run tau3:first airline 10 --keeled-tool-guide
```

`tau3` starts the bridge, runs `tau2 run --domain <domain> --agent keeled` in the τ³-bench
checkout, and stops the bridge. Any other `tau2 run` option passes through. The domain is passed through without special handling. The default is **one trial per task**;
keep screening runs at one trial until a promising change warrants a larger evaluation.

`tau3:first <domain> <count>` runs task IDs `0` through `count - 1`. It accepts other
`tau2 run` options after the count. For example, this runs the first 10 airline tasks one
at a time:

```sh
bun run tau3:first airline 10 --max-concurrency 1
```

| Variable                | Where           | Purpose                                                               |
| ----------------------- | --------------- | --------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`      | Keeled `.env`   | Jev controller                                                        |
| `OPENROUTER_API_KEY`    | Keeled `.env`   | Keeled's model calls                                                  |
| `KEELED_MODEL`          | Keeled `.env`   | OpenRouter model id, e.g. `anthropic/claude-sonnet-4.5`               |
| `OPENROUTER_PROVIDERS`  | optional        | Provider order, default `together,modal`; no fallback beyond the list |
| `OPENROUTER_API_KEY`    | τ³-bench `.env` | User simulator                                                        |
| `TAU2_USER_LLM`         | optional        | User simulator model, default `openrouter/openai/gpt-4.1`             |
| `TAU2_DIR`              | optional        | τ³-bench checkout, default `~/projects/tau2-bench`                    |
| `KEELED_JEV_MODEL`      | optional        | Jev model, default `jev-1.13.0`                                       |
| `KEELED_TOOL_GUIDE`     | optional        | `1` enables the tool guide; `--keeled-tool-guide` sets it             |
| `KEELED_TOOL_GUIDE_DIR` | optional        | Directory where each built guide is saved as `<key>.json`             |

The two key sets stay separate. τ³-bench never overrides variables already in its
environment, so the runner withholds Keeled's credentials from it and it reads only its
own `.env`.

Results land in the checkout's `data/simulations/`; view them with
`.venv/bin/tau2 view` from the checkout. `--agent-llm` is ignored by this agent.

## Metrics

```sh
bun run tau3:metrics <results.json> [more results...]
```

This prints tool-selection metrics per simulation and in total, from the saved results only:

| Metric                | Source                                                                   |
| --------------------- | ------------------------------------------------------------------------ |
| `toolErrors`          | Agent calls whose result was an error                                    |
| `unreferencedCalls`   | Agent calls to a tool no reference action uses; a proxy for a wrong tool |
| `missedReads/Writes`  | Evaluator action checks that did not match, by tool type                 |
| `neverCalled`         | Reference tools never called, with how many decisions offered each       |
| `offeredButNotChosen` | Total of those offers                                                    |
| `blockers`            | Declined attempts by kind, from the trace                                |

The first event of each session records its settings (`controller`, `jevModel`, `toolGuide`)
in a `session` trace entry, and each blocker is recorded once in a `blocker` trace entry.
Runs saved before this change have neither.

OpenRouter routing is pinned with `provider: { order, allow_fallbacks: false, require_parameters: true }`,
so requests go only to the listed providers, in order, and never to one that would drop
`response_format`.

Structured tool input is requested with `strictJsonSchema: false`, because τ³ tool schemas
use optional fields and open objects (`$defs`, `anyOf` with `additionalProperties`) that
strict mode rejects.

## Historical measurements

Earlier candidate and observed-argument experiments have been removed. Their saved results
do not establish the performance of the current harness. Raw historical run artifacts
remain unchanged.

## Generic harness changes after the snapshot

The snapshot results above predate the current changes and do not measure them.
Sessions now use the reusable task tracker and evidence calculation tool. Tests can disable
the tracker with `trackTasks: false`. The framework has no domain-specific policy, pricing, or ownership rules.

The stock server runs with the same generic instruction, evidence, and confirmation checks
as any other host. There is no domain adapter or host access callback. Model permission
checks do not establish authenticated identity.
