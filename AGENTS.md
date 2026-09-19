# Repository rules

Use concise Simplified Technical English in responses.

## Never optimize for a benchmark with use-case-specific code

Keeled is a general agent framework. Benchmarks test the framework; they must not shape
special-case implementations that improve benchmark scores.

- Never add domain-specific or benchmark-specific adapters, tool-name branches, field
  mappings, prompts, policies, heuristics, or answer shortcuts to the framework, examples,
  benchmark bridge, or runner. Moving a special case into an example does not make it valid.
- Consume tool contracts, descriptions, schemas, instructions, and observations as runtime
  inputs through the same general interfaces for every use case. Do not embed knowledge
  of benchmark tasks, expected trajectories, reference answers, or evaluator behavior.
- Fix failures at the general mechanism: argument grounding, state retention, validation,
  execution, arithmetic, authorization, or recovery. If a fix needs a particular business
  vocabulary or tool name to work, redesign it before committing.
- Test generic mechanisms with synthetic fixtures from multiple unrelated settings.
  Include renamed tools and negative cases to expose hidden domain assumptions. Do not
  copy benchmark fixtures into runtime logic or tailor a mechanism to their field layout.
- Host applications may provide real authenticated identity and authoritative access checks
  through generic interfaces. Never add a benchmark bypass or infer authorization from a
  simulated user's claims.
- Report benchmark scope and limitations honestly. Results from a special-case adapter
  are not evidence of general framework improvement. Keep historical measurements intact
  and clearly label them when an implementation is replaced.

Before committing, inspect runtime code, prompts, bridge code, and tests for use-case
special cases. Passing tests or a higher benchmark score never justify violating this rule.
