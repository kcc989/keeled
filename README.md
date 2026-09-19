# Keeled

An agent harness with Jev at the helm.

Action selection is separate from generation and execution.

| Component | Responsibility |
| --- | --- |
| Jev | In one `control()` call, selects a tool or a reply. |
| LLMs | Generate tool input and responses. |
| Tools | Do work and return evidence. |
| Runtime | Runs the loop, applies policy, persists results, and answers the user. |

Jev selects actions from the conversation and tool results. The runtime resolves arguments,
validates and authorizes the selected call, executes it, and returns its result to Jev.
There is no generated plan, goal-completion stage, or reply-review stage.
The public interface uses promises and AI SDK types.

## Packages

| Package | Contents |
| --- | --- |
| `@keeled/core` | `agentTool`, `createAgent`, the execution loop, state, messages. |
| `@keeled/core/testing` | A scripted controller and a stub model for offline tests. |
| `@keeled/jev` | The Jev controller, built on `@typesafe-ai/sdk`. |
| `examples/chat` | An offline demonstration, a live script, and an HTTP route. |

## Quick start

```sh
bun install
bun run demo       # offline: no API keys
bun run check      # typecheck and tests
```

## Usage

```ts
import { createAgent } from '@keeled/core';
import { jev } from '@keeled/jev';

const agent = createAgent({
  instructions: 'Complete the requested change and verify the result.',
  controller: jev(),
  model: 'anthropic/claude-sonnet-4-5',
  tools: { search, editFile, runTests },
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
| `candidates(context)` | Optional complete read-call inputs, each with a description and source references. Jev can select one without generating arguments. |
| `resolveInput(context)` | Produces the typed input. Without it, the runtime generates input from the schema. |
| `risk` | `read`, `write`, `destructive`, or, when unspecified, `unknown`. |
| `repeat` | `allow` (default) runs every call. `reuse` declares that a result stays valid until a state-changing call succeeds, so an identical repeat before then is declined. `poll` exempts repetition from progress checks for `pollTimeoutMs` (default 60 seconds). Never use `reuse` for polling or data that changes outside the agent. |
| `model` | Overrides default input generation. Custom callbacks pass their model to `context.generateObject` or `context.generateText`. |

Agent callbacks receive managed generation directly: `context.generateText(...)` and
`context.generateObject(...)`. Those calls carry usage accounting, timeouts, and cancellation.

Plain AI SDK function tools are accepted. They keep their native callback signature, get
default input generation, and register as unknown risk. Provider-defined, provider-executed,
and dynamic tools are rejected at registration.

Agent tools need this runtime. Reusing the SDK types does not make another loop supply the
agent context.

## Loop

Read tools can return `{ input, description, sources }` entries from `candidates(context)`.
Build these from explicit relationships in observed records, preserving related arguments
such as flight number and departure date. The runtime validates and stores a snapshot
before each decision. Jev returns a candidate ID; the runtime executes its stored input
through the normal policy and authorization checks. IDs from older snapshots in the current turn are rejected.
Tools remain selectable through ordinary input resolution when no ready call fits.
Candidate providers own freshness and repeat filtering. Only complete calls are offered;
missing arguments still use the normal resolver. The `call:` tool-name prefix is reserved.

Each cycle calls `controller.control()` once. Jev selects a ready call, a registered tool,
`respond:completed`, `respond:needs_input`, or `respond:blocked`.
A reply selection ends the loop and generates one response.

For a tool selection:

1. Check availability and application risk policy.
2. Resolve and validate input.
3. For a `reuse` tool, decline an identical repeat whose result still applies.
4. Authorize the call when its risk requires it.
5. Persist the input with a stable call id.
6. Execute once and record the result or error.

Input failures, tool failures, and declined calls become observations for the next decision.
Every cycle counts toward `maxSteps`, including blocked attempts.

Progress is measured in distinct evidence: a repeated identical result and a blocked
attempt add none. Repeating one action, or alternating between two, without new evidence
is first reported to the controller as `no_progress`; doing it again in the same turn ends
the turn as `blocked`. A `poll` tool is exempt until its time limit passes.

### Blockers

Every declined attempt is recorded with a kind and what would resolve it:

| Kind | Resolution |
| --- | --- |
| `needs_confirmation` | Ask the user. The tool is withdrawn for the rest of the turn; other tools stay available. |
| `missing_evidence` | Obtain the named evidence by a lookup or from the user. |
| `policy_denied` | Do not retry; explain, or choose a permitted action. |
| `invalid_input` | Obtain valid input. |
| `duplicate` | Use the result already in the call history. |
| `unavailable` | Choose an available tool. |
| `no_progress` | Change course, or respond with what is known. |

### Selection and input

Input resolution receives the selected tool through `context.action`, the conversation,
and observed results. A resolver that cannot produce input throws `MissingInformation`.
An action held for confirmation persists in the conversation. On the next turn, the runtime
validates and authorizes that exact input again before it can run.

### Evidence

Every tool result keeps its call id as a stable reference. Prompts show a result whole when
it fits; a larger list appears as a page of complete records with the number omitted and
how to retrieve the rest. Records are never reduced to field names. `evidenceTool()` reads
a stored result by reference, a page at a time, and can sort the full list by a field path,
summing across `[]` segments, so questions such as "cheapest" are answered over every
candidate.

Every finished turn produces a response, including blocked, failed, and incomplete turns.
Cancellation stops work at once, records the cancellation, and keeps partial text.

### Authorization

Calls whose risk is in `policy.authorization.risks` (by default `write`, `destructive`, and
`unknown`) are judged by the controller after their input resolves and before they run: is
the call permitted, would deciding that need calculation or detailed comparison, and has
any confirmation the instructions require been given. Unless the controller is confident
the call is permitted and confident no calculation is needed, the model checks the
instructions and evidence, and its verdict decides. A confirmation judged with less than
`confirmedFloor` confidence counts as absent. A refused call becomes a blocker, and an
identical retry in the same turn is refused again without another check unless the
results relevant to it have changed. A refusal records the instructions it applied, the
results it cited, and the state-changing calls so far; it is reconsidered when any of those
change, when any new evidence arrives for a refusal over missing evidence, and after a
minute when the verdict depends on time. A controller without `authorize` authorizes
nothing, and calls run as before.

### Replies

The responder generates text once. Empty text or tool-call markup is replaced by a
status response. There is no model review or regeneration. Prompts require replies to
use the conversation and tool results and to claim only actions that actually ran.

## Messages and state

The conversation uses AI SDK UI messages. Tool calls and results stay SDK tool parts. Data
parts are added only for controller decisions, blockers, and
operational transitions.

```ts
type AgentMessage = UIMessage<AgentMetadata, AgentDataParts, InferAgentUITools<typeof agent.tools>>;
```

`InferAgentUITools` applies the SDK's `InferUITools` to a type-only projection of the tool
map, so both tool forms keep their names and input/output types.

A pure, versioned reducer derives state from the persisted parts without running the
controller or tools. Each finished turn resets counters and blockers. Conversation text,
tool results, and pending confirmations remain available from the messages. An interrupted
turn replays to the state it reached. Checkpoints are informational; parts are authoritative.

Reducer version 3 ignores legacy plan, fact, and verification metadata. The planning tools,
plan types, goal statuses, `complete_step`, and reply-review interfaces have been removed.
Callers must remove planning registration and use tool or reply decisions.

The host persists message updates during execution. Without incremental persistence there is
no crash-recovery guarantee, and this phase never resumes an interrupted write.

## Policy

```ts
policy: {
  maxSteps: 30,
  repeatLimit: 3,
  allowedRisks: ['read', 'write'],
  authorization: {
    risks: ['write', 'destructive', 'unknown'],
    permittedFloor: 0.6,
    verificationFloor: 0.6,
    confirmedFloor: 0.6,
  },
  inferredConfidenceFloor: 0.6,
  generationTimeoutMs: 30_000,
}
```

The authorization floors default to `inferredConfidenceFloor`.

`allowedRisks` applies to both tool forms and controls unknown-risk tools. An unspecified
risk is unknown, not read-only.

## Not implemented

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
- The final response is generated with `generateText` and emitted as text chunks. A `respond` adapter can replace text generation.

## Next

Measure task success, latency, and total cost against an LLM-controlled loop.
Treat any performance benefit as a hypothesis until it is measured.
