# Keeled

An agent harness with Jev at the helm.

Action selection is separate from generation and execution.

| Component | Responsibility |
| --- | --- |
| Jev | In one `control()` call, selects the next action for the current plan step. |
| LLMs | Generate plans, tool input, and responses. |
| Tools | Do work and return evidence. |
| Runtime | Runs the loop, applies policy, persists results, and answers the user. |

Every task has an internal plan. Simple tasks keep a one-step implicit plan, which a UI
can hide. Complex requests use the replaceable planning tool to create an explicit multistep
plan. The public API uses promises and AI SDK types.

This repository implements **Phase 1** of `jev-agent-harness-roadmap.md`: tool selection and plans.

## Packages

| Package | Contents |
| --- | --- |
| `@keeled/core` | `agentTool`, `createAgent`, the execution loop, plans, state, messages. |
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
| `repeat` | `allow` (default) runs every call. `reuse` declares that a result stays valid until a state-changing call succeeds, so an identical repeat before then is declined. `poll` exempts repetition from progress checks for `pollTimeoutMs` (default 60 seconds). Never use `reuse` for polling or data that changes outside the agent. |
| `model` | Overrides generation inside the tool. |

Agent callbacks receive managed generation directly: `context.generateText(...)` and
`context.generateObject(...)`. Those calls carry usage accounting, timeouts, and cancellation.

Plain AI SDK function tools are accepted. They keep their native callback signature, get
default input generation, and register as unknown risk. Provider-defined, provider-executed,
and dynamic tools are rejected at registration.

Agent tools need this runtime. Reusing the SDK types does not make another loop supply the
agent context.

## Loop

The runtime owns the plan state machine. It selects the first ready step and calls
`controller.control()` once. Jev sees that one step and chooses a domain tool,
`step:complete`, `respond:needs_input`, or `respond:blocked`. A domain tool result is attached
to the current step. `step:complete` crosses it off. When all steps are crossed off, the task
completes without another controller call.

At task setup, planning does not compete in the action menu. The same Jev request includes
one focused judgment about whether the implicit request needs multiple tracked steps. A
positive answer routes to the planning tool; otherwise the selected domain action runs. An
implicit task gets the setup judgment again after a user clarification. During normal
execution planning is hidden. The runtime offers revision once after a tool failure or a
no-progress report. This prevents the plan from being replaced on every cycle.

1. Check availability and step dependencies.
2. Resolve and validate input.
3. For a `reuse` tool, decline an identical repeat whose result still applies.
4. Authorize the call when its risk requires it.
5. Prepare an immutable invocation with a stable call id.
6. Apply application policy and persist the call.
7. Execute once, and record the result or the tool error.
8. For the planning tool, validate the proposal and persist the next revision.

Input failures, tool failures, and declined calls become observations. They do not end the
turn. A tool failure opens one plan-recovery opportunity. Every cycle counts toward
`maxSteps`, including blocked attempts.

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
| `completion_refused` | Obtain what the request still needs, or respond that it cannot be done. |
| `no_progress` | Change course, or respond with what is known. |

### Selection and input

A tool action may carry an `objective` and `evidence` references, which reach input
resolution as `context.action`. An action held for confirmation is found again in later
turns, offered to resolution as `context.action.awaitingInput`, and authorized again before
it runs. A resolver that cannot produce input throws `MissingInformation` with what is
needed rather than inventing values.

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

A reply must be plain text. Tool-call markup from a model's chat template is a broken
contract: the reply is regenerated once with the problem as feedback, and replaced by a
status response if it is still broken. A controller with `reviewReply` also checks that the
reply addresses the request and claims only supported outcomes; a reply that falls short
is regenerated once.

## Plans

A plan states objectives and dependencies. It never names tools. Each step also states its
constraints, observable completion criterion, and the references of tool results produced
for that step.

Every task starts with a one-step `implicit` plan representing the request. It needs no model
call. At setup, a focused Jev judgment keeps it for a direct answer or routes to the planning
tool for work with multiple obligations, entities, or dependent actions. This judgment is
asked again when an implicit task continues after the user supplies more information.
The explicit plan then stays fixed while the runtime crosses off steps. The plan and
completed-step evidence persist when the task pauses for user input or confirmation. The
planning tool becomes available again only after a tool failure or no-progress report.
After a terminal outcome, the next request starts a fresh implicit plan.

The planning tool returns a replacement proposal without a revision number. The runtime
validates ids, dependencies, and cycles, then assigns the next revision. A step keeps its
status when its id, objective, dependencies, constraints, and completion criterion are
unchanged; otherwise its verification is invalidated.

Phase 1 uses the controller's `step:complete` selection, so completion is labelled
`inferred`. It is never labelled `verified`. Explicit conditions arrive in Phase 3.

Completion records are kept apart from the plan. A crossed-off step stays complete during
normal execution. A plan revision carries the result for an unchanged step and reopens a
step whose objective, dependencies, constraints, or completion criterion changed.

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
to anything the tool returned. Input resolution receives that full step, including its
constraints, completion criterion, and prior evidence references.

A pure, versioned reducer derives state from the persisted parts. It never re-runs the
controller or the tools. A task that stops for user input carries its plan and progress into
the reply turn but resets loop-local counters and blockers. Other terminal outcomes close the
task. A replay of an interrupted turn reconstructs the state it reached. A checkpoint is
written to message metadata; the persisted parts remain authoritative.

The host persists message updates during execution. Without incremental persistence there is
no crash-recovery guarantee, and this phase never resumes an interrupted write.

## Policy

```ts
policy: {
  maxSteps: 30,
  repeatLimit: 3,
  maxPlanRevisions: 5,
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
