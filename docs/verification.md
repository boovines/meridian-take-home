# Verification

## Current checks

The `scaffold` CI job checks required repository files and whitespace errors. The required `app` job runs lint, typecheck, a production build, Temporal bundling, service/domain tests against PostgreSQL, and seven browser journeys using sanitized fixtures. Live provider checks remain separate.

The required suite also exercises actual Temporal worker cancellation using the [official testing SDK](https://docs.temporal.io/develop/typescript/best-practices/testing-suite) and a temporary local server. It cancels execution, evaluation and repair while an activity is still acknowledging cancellation, then verifies cleanup and the absence of failed workflow tasks. Database fixtures and workflow bundling alone cannot establish this behavior.

## Add checks with implementation

| Stage | Required verification |
| --- | --- |
| App initialization | Basic lint, typecheck, production build using a committed lockfile |
| Business logic | Focused unit tests for validation, counting, state transitions, and bounded repair |
| Persistence/API | A small integration suite against an isolated test database, including migrations and draft/frozen-spec behavior |
| Working user journey | One reliable browser test: create, save, reload, freeze, inspect the frozen spec |
| Consequential UI behavior | Selective component tests where useful, such as preventing an invalid freeze |

Run added tests in CI and require their checks once verified. Do not skip failures or substitute placeholder passing tests. Formatting can run locally; coverage targets, broad browser matrices, load tests, and exhaustive snapshots are outside the initial scope.

## Important cases

- Draft edits cannot mutate a frozen specification.
- AI suggestions cannot silently overwrite owner decisions.
- Saving and reopening preserves nodes, edges, and comments, including workflow loops.
- A good missing two required fields counts as one failed good; duplicate CoAs cannot inflate batch counts. Confirm unresolved business rules before encoding expected results.
- Repair stops at its configured limit, preserves fixed expected answers, and reports unresolved failures honestly.

Use sanitized fixtures and deterministic external-service substitutes for required CI. Run live Gmail/Composio and LLM checks separately before the demo and after relevant integration changes. Record their results and limitations; fixture success does not establish that live credentials or services work.

Record exact commands and meaningful manual walkthrough results in each PR. Review expected evaluation answers independently of generated implementation.

## Detailed acceptance checks

These are the acceptance scenarios for the consolidated design. See [implementation status](implementation-status.md) for measured test counts and live outcomes; this checklist does not itself establish that every scenario passed.

## Database and mutation checks

| Scenario | Required result |
| --- | --- |
| Cross-workflow edge, anchor, version, or artifact reference | Reject ownership mismatch. Runtime group/step links must also belong to the same run. |
| Two tabs save the same node or finding | Reject the stale revision; keep the client's unsaved text recoverable. |
| Only a block's position changes | Save layout without invalidating semantic review identity. |
| Apply and resolve encounters a stale node or thread | Neither the proposed edit nor the closure persists. |
| Cancel review, edit, then receive the old callback | Old work cannot publish findings or release a newer review lock. |
| Goal is supplied during clarification | Recorded analyzed snapshot/revision includes the confirmed goal. |
| Customer reopens a resolved finding | Preserve disposition history; finding blocks freeze again. AI cannot reopen it. |
| Open customer note | Does not block freeze. |
| Delete an open finding's sole block | Close with deletion reason; retain original context. Multi-target policy remains explicit. |
| Freeze without completed review, or with open findings/invalid graph | Reject and identify actionable fixes. Cover disconnected nodes, multiple triggers, invalid endpoints, and invalid joins. |
| Freeze valid but changed content | Require warning acknowledgment or another review. |
| Freeze races an edit, or request is repeated | Exactly one consistent immutable snapshot; no partial lock or silent lost edit. |
| Plan or suite is revised | Existing code, results, and expectations still resolve to their original versions. |
| Case edit races another edit or suite lock | Reject stale edits; serialize through the suite, clear prior verification, and never lock an unverified revision. Empty suites cannot lock. |
| Artifact/version is inspected | Project hashes come from their immutable artifact; no divergent copied hash. The fixed host grader is separate from generated source. |

## Evaluation and repair checks

Independently verify supplied expected values before locking fixtures. Mismatched-invoice scoring is excluded; batch/CoA matching remains covered. Do not automatically propagate a CoA failure to a failed invoice unless verified rules require it.

- Two missing fields on one good produce one failed good, two discrepancy details, and a failed invoice. Duplicate invoice/batch cases exercise the specified deduplication scope.
- A single-case parser error does not prevent independent cases completing. A shared build failure marks the evaluation blocked and remaining cases not run.
- An expired credential is operational; generated code failing to compile can be a repairable implementation failure. Failure classification controls whether repair is appropriate.
- Missing results, fixture responses, errors, cancelled cases, and targeted-only checks cannot produce a full-suite pass.
- A candidate fixing one assertion while breaking a previously passing assertion is rejected. The next attempt starts from the retained baseline, not the newest artifact. Compare the same locked suite and stable assertion IDs.
- Failed generation still leaves an attempt record. Three attempts stop the session; method, frozen-process, or expected-answer changes require engineer attention sooner.
- A corrected suite creates a new version and requires a fresh baseline evaluation/session. Prior evidence remains intact.
- Verify that candidate code cannot write trusted fixtures, evaluator code, or acceptance records. A prompt telling it not to is insufficient isolation.

## Runtime and recovery checks

- Retry creates a fresh linked run with identical code and captured inputs, preserving the failed trace. Changed documents create a new bundle/run.
- Human decisions belong to individual visits; repeated visits require fresh responses. Duplicate submissions schedule only one continuation. Evaluation fixtures never silently bypass real human requirements in manual runs.
- Missing scripted human responses fail an evaluation case instead of waiting indefinitely.
- Different scheduling orders for independent branches select the same fixture responses by node and per-node visit number; retries within a visit do not consume another scripted response.
- Repeated visits to the same parallel split create separate groups. Old arrivals cannot satisfy a new join, and duplicate completion cannot schedule the merge twice.
- A branch crash permits already-running siblings to finish within limits, records their outputs, and blocks the incomplete merge. Do not launch new downstream work after the required branch fails.
- Exclusive routing errors on multiple matches; no match follows Otherwise if defined, otherwise errors. No dependence on display order.
- Infinite loops and hung handlers hit server-enforced budgets. Human waiting is excluded from active time; overlapping active branches are not double-counted. Limit exhaustion never appears as success.
- Closing the browser does not kill durable work. Human waiting holds no live worker unnecessarily.
- Competing top-level operations in one workflow admit only one; independent workflows remain separate. Repair's child evaluations do not compete with their own root job.
- Recover from a crash between database job creation and dispatch. Duplicate/expired workers are fenced before publishing outputs, continuing steps, or promoting candidates.
- Confirm one authoritative executor for claims, retries, and joins. If using an executor-owned implementation, its database projections cannot independently schedule transitions.
- Cancellation preserves completed history and prevents late continuation/promotion. No evaluation, repair, or manual run sends report email.

## Customer walkthrough

Create and reopen a named workflow; supply its outcome; map a loop and paired parallel section; complete two review rounds including an unnecessary-step suggestion; resolve findings; demonstrate one stale-save conflict; freeze. In engineer view, approve methods, generate inspectable code, run the trusted suite, inspect a failure, and start bounded repair. Show why a regressing candidate was retained but not promoted. Finally capture an existing Gmail shipment, exercise a human pause/response, and inspect its report preview and trace.

## Checks performed on documentation

The initial documentation-only checkpoint checked whitespace and local link targets before implementation. Current CI exercises executable migrations and application behavior; live evidence and known accuracy limits are recorded in [implementation status](implementation-status.md). Source diagrams describe the implemented boundaries and are not a load-test result.
