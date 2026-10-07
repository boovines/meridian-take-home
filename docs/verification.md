# Verification

## Current checks

The `scaffold` CI job checks required repository files and whitespace errors in the PR diff. There is no application or test runner yet; a green scaffold check is not evidence of product correctness.

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
