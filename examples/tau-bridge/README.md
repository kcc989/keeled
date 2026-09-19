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

A tool executed inside the agent (Design B) never reaches the trajectory, so the replayed
database and the action checks would both miss it. Design B is not viable.

Design A needs a turn that can pause at a tool call. `Agent.run` runs a whole turn and
`@keeled/core` has no suspend/resume, so the pause lives in the bridge instead:

1. Each τ³ tool is registered as an `agentTool`. Keeled's controller selects it and the
   runtime resolves and validates its input exactly as for any other tool.
2. Its `execute` returns a promise the bridge holds open, and the bridge answers the pending
   HTTP request with the tool call.
3. τ³ executes the call and records it. The next request carries the `ToolMessage`, which
   resolves the held promise, and the unmodified loop continues.
4. When the controller chooses to respond, the turn ends and the text is returned.

`@keeled/core` is unchanged.

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
turns and the runtime defaults read only the latest request.

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
`airline` are tested; other domains run with a warning.

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
