# Tool guide: instruction rules and input sources in tool selection

Date: 2026-09-25. Status: **built as an opt-in option; not measured on a benchmark**.

## Hypothesis

Many failures come from calling the wrong tool, or from calling tools in the wrong order.
Jev sees the full instructions as one block of state, and each tool option has only its
description, its risk, and generic guidance. Jev must find the rules for each tool again on every
decision. If each tool option quotes the instruction segments that govern it, and names
the tools that supply its inputs, then selection should improve.

The prior records support part of this hypothesis:

- **Wrong tool:** the full discovery run had six wrong-tool reads, and the first-ten screen had two.
- **Order:** some candidates asked for a lookup's output before they allowed that lookup, and
  correct lookups were offered many times and not chosen.

The records do not label failures by cause, so the share that this mechanism can reach is not known.

## Mechanism

The guide follows the TypeSafe cookbook patterns
[semantic find](https://docs.typesafe.ai/cookbooks/semantic_find) and
[entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment).
It is in `packages/jev/src/guide.ts`.

1. Code splits the instructions into numbered segments (`I000|`). Markdown headings, lead-in
   lines that end with a colon, and parent list items become the scope of each segment. A line
   longer than 360 characters is split at sentence ends.
2. The first pass asks, for each tool of the full catalog:
   - one Noul: does any segment set a rule for when to call it, what must come before it, or
     whether it may run?
   - one Choice over segment numbers (at most 250 options per Choice; longer instructions use
     several windows);
   - one Choice for each required input, over the other tools and a user option.
3. For each tool with a Noul of at least 0.35, the second pass confirms the eight
   highest-ranked candidates, each with its own Noul. A segment with 0.5 or more becomes a
   rule. The Noul gate is necessary, because a Choice always ranks some segment first.
4. Each tool option quotes its rules in document order and names each input source at 0.5 or
   more. For each source, it says whether that tool returned a result, only failed, or has not
   been called in the conversation.

Jev picks segment numbers and never writes rule text. The guide adds only option text. Authorization,
input resolution, validation, confirmation, and repetition checks are unchanged. The guide
contains no domain vocabulary; tests use library, deployment, and archive settings with
renamed tools and an unrelated tool.

The controller caches one guide for each combination of instructions, catalog, Jev model, and
options, and shares it across conversations. A build has a 120-second limit. A cancelled
turn stops waiting, but the build continues for later turns. A failed build leaves selection
unchanged and is not retried in that process. The first turn that reads a finished guide
carries its Jev usage.

## Verification so far

- `bun run check` passes: lint, format, TypeScript, and 135 tests (111 before this change).
- A live screen used a synthetic library setting with `jev-1.13.0`. The build used 2 Jev
  calls, about 5,100 input tokens, and under one second.
  - Rules and input sources were correct for all five tools.
  - It missed one rule: "Never share one member's loans with another member" was not attached
    to the loan listing tool.
  - With the tools renamed and an unrelated tool added, the structure stayed the same. The
    unrelated tool scored 0.06 and got no rules.
- A live `control()` call with the guide on selected the member lookup first, as the
  instructions require. This checks that the API accepts the request. It is not evidence of
  better selection.

These checks show that the mechanism works. They do not show that it improves task success.

## How to measure it

Run the same tasks with and without the guide on the same bridge, with `jev-1.13.0`
(now the bridge default), and compare with `bun run tau3:metrics`:

```bash
bun run tau3:first airline 10 --max-concurrency 1
KEELED_TOOL_GUIDE_DIR=.guides bun run tau3:first airline 10 --max-concurrency 1 --keeled-tool-guide
bun run tau3:metrics <baseline results.json> <guide results.json>
```

Primary metrics: unreferenced calls, tool errors, reference tools offered but never chosen,
blockers by kind, and missed reads and writes. Also record task success, latency, and cost,
including the build cost. Save the built guide and review every rule for each tool before
reading the scores.

Before adoption, the guide must:

- repeat on held-out tasks in more than one domain, with several trials;
- improve the primary metrics without more wrong writes;
- keep its results and failures in this record, including runs that did not improve.

## Limits

- The recall of rules is not measured. The live screen missed one permission rule.
- Input sources are judged from tool descriptions. Tools without result descriptions give
  weaker sources.
- The guide describes rules; it does not check whether a rule is met.
- The build cost is charged to the turn that first reads the guide, so one task's controller
  tokens include it.
- The cookbook thresholds come from `jev-1.12`. These floors are not tuned on labeled Keeled data.
