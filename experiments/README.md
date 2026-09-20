# Experiment record

Read this index before repeating or extending a controller experiment. Each record
must distinguish the hypothesis, tested implementation, measured results, and
adoption decision. Keep failed runs and measurement limits visible.

| Experiment                          | Status                                     | Result                                                                                            | Record                                                                                                         |
| ----------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Bounded discovery: full airline set | Keep experimental and opt-in               | 34/50; six wrong-tool reads; one wrong-ranking booking; 28 unmatched reference writes             | [Full results](../docs/experiments/discovery-continuation-full50.md)                                           |
| Bounded discovery continuation      | Keep experimental and opt-in               | 9/10 airline cases; 18 prepared reads; two wrong-tool reads; two missed writes                    | [Results and limitations](../docs/experiments/discovery-continuation.md)                                       |
| 3: One reasoning call at a stall    | Rejected configuration; documentation only | 8/10 airline cases versus a saved 9/10 baseline; 24 recovery calls; three missed reference writes | [Design](recovery/README.md), [results and limitations](recovery/RESULTS.md), [metrics](recovery/summary.json) |
| Joint tool and argument generation  | Keep opt-in; do not adopt as default       | 9/10 airline cases; one timeout; one duplicate write attempt; 36 rejected outputs                 | [Results and limitations](../docs/experiments/joint-tool-argument-generation.md)                               |

Experiment numbers follow the original proposal. This index does not imply that
Experiments 1 and 2 were run or combined in this checkout.

## Guidance for future work

For Experiment 3, preserve the following findings:

- A blocked reply is not always a recoverable stall. The tested trigger also ran
  before valid policy refusals and invoked recovery in nine of ten cases.
- One attempt per stored key does not mean one attempt per unresolved goal. New
  user messages can change the key while the underlying blocker remains similar.
- Recovery did not finish the available lookups in case 8. Do not claim that a
  reasoning model alone solved missing dependencies.
- The experiment exposed an independent schema-validation gap. A separate fix should preserve Zod
  validation for Zod contracts and add real validation for supplied JSON Schema.
  Recovery proposals never grant permission to execute.
- Lower measured latency and estimated cost did not offset the success loss.
  These single trials against a historical baseline do not establish causation.

A new trial should test a materially different mechanism: narrower stall evidence,
a relevant-state allowance that survives unrelated dialogue, or better dependency
resolution. Label it as a new configuration. Preserve these results and compare
against a compatible saved baseline; do not silently replace failed measurements.
Before adoption, repeat held-out tasks, include a plain LLM controller under the
same safeguards and budgets, and record full failed-work cost and write outcomes.

The committed reports and compact metrics are the durable record. Raw traces and
source snapshots are local, ignored artifacts; their absolute paths document
provenance and are not portable dependencies. Read the report's telemetry limits
before using the numbers in another comparison.
