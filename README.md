# Keeled

An agent harness with Jev at the helm.

Action selection is separate from generation and execution.

| Component | Responsibility |
| --- | --- |
| Jev | Selects actions and assesses progress. |
| LLMs | Generate plans, tool input, and responses. |
| Tools | Do work and return evidence. |
| Runtime | Runs the loop, applies policy, persists results, and answers the user. |

Planning is a replaceable tool. It does not control the loop. The public API uses promises and AI SDK types.

This repository implements **Phase 1** of `jev-agent-harness-roadmap.md`: tool selection and plans.

## Packages

| Package | Contents |
| --- | --- |
| `@keeled/core` | `agentTool`, `createAgent`, the execution loop, plans, state, messages. |
| `@keeled/core/testing` | A scripted controller and a stub model for offline tests. |
| `@keeled/jev` | The Jev controller and Jev compaction, built on `@typesafe-ai/sdk`. |
| `examples/chat` | An offline demonstration, a live script, and an HTTP route. |

## Quick start

```sh
bun install
bun run demo       # offline: no API keys
bun run check      # typecheck and tests
```

## Usage

```ts
import { createAgent, planningTool } from '@keeled/core';
import { jev } from '@keeled/jev';

const agent = createAgent({
  instructions: 'Complete the requested change and verify the result.',
  controller: jev(),
  model: 'anthropic/claude-sonnet-4-5',
  tools: { plan: planningTool(), search, editFile, runTests },
  planningTool: 'plan',
  policy: { maxSteps: 30 },
});

const result = await agent.run({ messages, abortSignal });

// The same execution, streamed:
const stream = agent.stream({ messages, abortSignal });
return stream.toUIMessageStreamResponse();
```

`run` returns the complete updated messages, the new assistant text, usage, and a stop
reason. It does not mutate the input messages.

Stop reasons are `completed`, `needs_input`, `blocked`, `limit`, `error`, and `cancelled`.
They are separate from provider finish reasons.

## Tools

```ts
const editFile = agentTool({
  description: 'Apply a change to a file.',
  inputSchema: z.object({ path: z.string(), from: z.string(), to: z.string() }),
  outputSchema: EditResultSchema,
  risk: 'write',
  resolveInput: context => buildEditInput(context),
  execute: (input, context) => applyEdit(input, context.abortSignal),
});
```

| Field | Behavior |
| --- | --- |
| `available(context)` | Excludes the tool from selection when false. |
| `resolveInput(context)` | Produces the typed input. Without it, the runtime generates input from the schema. |
| `risk` | `read`, `write`, `destructive`, or, when unspecified, `unknown`. |
| `model` | Overrides generation inside the tool. |

Agent callbacks receive managed generation directly: `context.generateText(...)` and
`context.generateObject(...)`. Those calls carry usage accounting, timeouts, and cancellation.

Plain AI SDK function tools are accepted. They keep their native callback signature, get
default input generation, and register as unknown risk. Provider-defined, provider-executed,
and dynamic tools are rejected at registration.

Agent tools need this runtime. Reusing the SDK types does not make another loop supply the
agent context.

## Loop

Each cycle assesses progress, asks the controller for one action, and either runs one tool
or ends the turn.

1. Check availability and step dependencies.
2. Resolve and validate input.
3. Prepare an immutable invocation with a stable call id.
4. Apply application policy and persist the call.
5. Execute once, and record the result or the tool error.
6. For the planning tool, validate the proposal and persist the next revision.

Input failures and tool failures become observations. They do not end the turn. Every cycle
counts toward `maxSteps`, including blocked attempts. Repeating an action without new
evidence ends the turn as `blocked`.

Every finished turn produces a response, including blocked, failed, and incomplete turns.
Cancellation stops work at once, records the cancellation, and keeps partial text.

## Plans

A plan states objectives and dependencies. It never names tools.

The planning tool returns a replacement proposal without a revision number. The runtime
validates ids, dependencies, and cycles, then assigns the next revision. A step keeps its
status when its id, objective, and dependencies are unchanged; otherwise its verification is
invalidated.

Phase 1 uses the controller's judgment for step and goal completion, so completion is
labelled `inferred`. It is never labelled `verified`. Explicit conditions arrive in Phase 3.

Verification results are kept apart from the plan. A result is `passed`, `failed` or
`unknown`, and the three are not interchangeable: `unknown` reports absent evidence, so it
never overwrites a result already recorded against the current plan revision. Only a
`failed` result or a plan revision regresses a step. Without that rule a controller whose
confidence merely wobbled would un-complete finished work.

## Messages and state

The conversation uses AI SDK UI messages. Tool calls and results stay SDK tool parts. Data
parts are added only for controller decisions, plan revisions, verification, blockers, and
operational transitions.

```ts
type AgentMessage = UIMessage<AgentMetadata, AgentDataParts, InferAgentUITools<typeof agent.tools>>;
```

`InferAgentUITools` applies the SDK's `InferUITools` to a type-only projection of the tool
map, so both tool forms keep their names and input/output types.

Tool evidence is attributed to the step named by the decision that selected the call, never
to anything the tool returned.

A pure, versioned reducer derives state from the persisted parts. It never re-runs the
controller or the tools. A terminal transition closes a turn, so a replay of a finished
conversation starts the next turn clean, and a replay of an interrupted one reconstructs the
state it reached. A checkpoint is written to message metadata; the persisted parts remain
authoritative.

The host persists message updates during execution. Without incremental persistence there is
no crash-recovery guarantee, and this phase never resumes an interrupted write.

## Compaction

Compaction is non-destructive. It never rewrites stored messages. It changes the *view* of the
history that a turn runs on, the same approach as Cloudflare Think.

```ts
import { jev, jevCompactor } from '@keeled/jev';

const agent = createAgent({
  // ...
  controller: jev(),
  compaction: { compactor: jevCompactor({ minReduction: 0.25 }), thresholdChars: 100_000 },
});
```

Compaction is off by default. Before each turn, the runtime builds the view by applying
every compaction already recorded in the messages. If the serialised view is over
`thresholdChars`, it asks the compactor for an edit. An edit can do two things:
- remove or rewrite tool parts, by tool call id;
- replace the messages before a given message with a summary.

The runtime records the edit as a `data-compaction` part in the turn's message and runs the
turn on the edited view. `result.messages` still holds the full history, plus the record.
`compactedView(messages)` rebuilds the view whenever it is needed.

Because the trigger measures the view, a recorded compaction keeps later turns under the
threshold without compacting again. This holds even when a client such as `useChat` resends
its full history.

The runtime rejects an edit that would change the state reduced from the open turn (every
part after the last terminal transition), and records that rejection. A failed compaction is
recorded too. In both cases the turn continues on the unchanged view. Compactor usage counts
toward the turn. `compactor` accepts any function, so core does not depend on Jev.

The runtime already projects only text into model calls and keeps controller evidence to the
current turn. So today the view mainly shrinks the text transcript given to models, and what
tools and `respond` adapters see through `context.conversation`.

### Jev compaction

`jevCompactor` and `compactMessages` from `@keeled/jev` are ported from
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction). For each finished tool
part, Jev answers two `noul` questions: whether the call still matters, and whether its full
result must stay verbatim. Jev sees the whole conversation with the tool results left out.
Against `keepThreshold`, each call is kept, has its result truncated to a head and a note, or
is removed. Text and data parts are never changed. The history is fitted into
`maxStateTokens` in stages, and the questions are split so each request stays under
`maxRequestTokens`.

The first message, the newest `preserveRecentMessages`, and the open turn are never
candidates. The checkpoint in message metadata keeps a copy of each tool output, and that copy
is edited the same way in the view. If Jev would remove less than `minReduction`, no edit is
made. Called directly, `compactMessages` returns both the `edit` and the resulting view, and
throws an error on Jev failures, malformed answers, and histories it cannot fit.

In the view, a truncated output is a string. That only matters to code that reads the view
and checks it against tool output schemas. The stored parts keep their original outputs.

### Summary compaction

`summaryCompactor` from `@keeled/core` is the standard alternative. It uses a model to
replace the older messages in the view with one summary.

```ts
import { summaryCompactor } from '@keeled/core';

compaction: { compactor: summaryCompactor({ keepRecentMessages: 2 }), thresholdChars: 100_000 },
```

| | `jevCompactor` | `summaryCompactor` |
| --- | --- | --- |
| Removes from the view | Stale tool calls and results | Everything older than the kept tail |
| What stays | Verbatim | A model's summary of it |
| Text messages | Never changed | Summarized |
| Cost | Jev requests (controller usage) | One model call (model usage) |

In the view, the summary is an assistant message marked with `metadata.summary`. That way,
tool output quoted in the summary never gets the authority of a user message. The newest
`keepRecentMessages`, the latest user request, and the open turn are always kept word for word.
The summarizer uses the agent's model by default (`model` overrides it). It sees text, plans,
blockers, and tool inputs and outputs, each clipped to `maxToolChars`. If the transcript is
longer than `maxTranscriptChars`, the oldest entries are left out. On later compactions, the
previous summary is summarized again together with the newer messages. An empty summary counts
as a failure.

## Policy

```ts
policy: {
  maxSteps: 30,
  repeatLimit: 3,
  maxPlanRevisions: 5,
  allowedRisks: ['read', 'write'],
  inferredConfidenceFloor: 0.6,
  generationTimeoutMs: 30_000,
}
```

`allowedRisks` applies to both tool forms and controls unknown-risk tools. An unspecified
risk is unknown, not read-only.

## Not in this phase

Semantic safety checks (Phase 2), the `condition` registry, tool preconditions, and explicit
plan verification (Phase 3). Schema validation and the risk policy above still apply.

Also deferred: parallel tool execution, provider-executed tools, model routing beyond the
explicit `argumentsModel` / tool model / agent model order, and durable crash recovery.

## Notes on dependencies

- `ai@7.0.105` and `@ai-sdk/provider-utils@5.0.43` are pinned. The tool, message, and stream
  types come from them.
- `@typesafe-ai/sdk@0.6.0` is pinned in `@keeled/jev` only. The core package does not
  depend on it.
- Effect is not used yet. The internal concurrency in this phase is a single tool at a time,
  so plain `async`/`await` with `AbortSignal` covers it. The public API is promise-based
  either way, so Effect can be introduced internally without an API change.
- The final response is generated with `generateText` and emitted as text chunks. Supply a
  `respond` adapter to stream tokens instead.

## Next

Before Phase 2, measure task success, latency, and total cost against an LLM-controlled loop.
Treat any performance benefit as a hypothesis until it is measured.
