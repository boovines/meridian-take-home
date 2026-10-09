# Selected-email grouped execution

## Implementation status

The server and worker implementation is in progress on the grouped-execution branch. The API, parent coordinator, grouping/aggregation phases, and fixture worker journeys are implemented. The product UI and live multi-email verification are still pending; this document does not claim the feature is ready for customer use.

## Input and execution

An engineer selects up to ten distinct email IDs and a generated implementation from an approved plan. The parent operation captures only those emails and their attachments. Capture publishes an immutable bundle only after all requested evidence is saved. The existing Gmail reader remains read-only.

The approved Trigger implementation runs in explicit `grouping` mode through the normal step runner. It returns groups and one disposition for every captured source: scoped assignments, a clarification question for an unresolved portion, or an exclusion reason. Multiple emails can support one group, and one source can contribute to several groups. Host validation checks identities, ownership, bounds and coverage; it does not certify the semantic correctness of assignments.

Each group receives a separate sealed input bundle and ordinary child workflow run. The generated workflow owns business grouping rules and results. The parent owns scheduling, source coverage, shared limits and cancellation. Child jobs use the parent's operation slot rather than competing for independent top-level slots.

## Clarification and recovery

Questions and submitted answers retain their original wording. After the current questions are answered, regrouping receives a new sealed bundle containing the unchanged captured sources, prior decision and answers. The original bundle is not edited. Unchanged child inputs are reused; changed inputs produce linked successor children. Superseded active children are cancelled while their completed history remains available. Grouping permits at most three clarification rounds.

Implementation failures use the existing bounded run-recovery service, approved methods, build checks and any locked regression suite. Recovery preserves the source run's mode and input bundle. The parent exposes the actual accepted run/code version for each group or phase. Group-specific recovery does not promote a new default for unrelated manual runs. Completion without trusted evaluation remains explicitly unverified business output.

## Combined report

The approved Outcome implementation runs in `aggregate` mode after the current groups settle. With multiple Outcome blocks, the engineer selects the one that should create the combined report. The host passes each group's actual run/version/input references, status, output or error, plus grouping coverage. Generated aggregation must preserve unknowns and limitations rather than count missing or failed work as zero or success.

The host's overall execution status is separate from the business summary. A parent succeeds only when source coverage is complete, every current child completes, and aggregation completes. Partial reports remain inspectable when independent work fails. A negative business result is not itself an execution failure.

## Bounds and persistence

Migration 017 adds parent job ownership, grouped captures, immutable decisions/child provenance, clarification questions, durable inference reservations and expiring activity-capacity leases. One parent owns the workflow's active-operation slot. Two heavy activities share capacity, including resumed human steps; pauses do not hold a capacity lease. Applied limits and original captured input cannot change.

The parent retains a shared active-time ledger, a wall deadline and a $5 inference allowance. Group/repair reservations compose with any operator-level budget. Unknown provider outcomes retain their reservations across restart. Each run and repair also retains its existing bounds. Parent cancellation fences late publication, closes pending questions and preserves completed results; Temporal requests cancellation of active children.

## API and module boundaries

- `GET/POST /api/workflows/:id/grouped-executions`: list version-scoped history or start selected-email execution.
- `GET /api/workflows/:id/grouped-executions/:jobId`: group results, coverage, clarification and provenance.
- `POST /api/workflows/:id/grouping-questions/:questionId/answer`: immutable, idempotent clarification response.
- Existing job cancellation and run/human-response endpoints remain the action boundaries.

Domain contracts live in `src/domain/grouped-execution.ts`. Parent services, state projection, budgets and capacity live in `src/server/grouped-execution`. Durable orchestration lives in `src/worker/grouped-workflow.ts`; provider/capture work remains in activities and existing integrations.

## Verification and remaining work

`grouped-runtime.test.ts` exercises immutable capture/limits, source validation, clarification-derived inputs, unchanged-child reuse, partial aggregation, cancellation, shared capacity and recovery-version provenance. `grouped-worker.test.ts` uses a real local Temporal server with sanitized adapters and actual persistence to verify restart followed by human continuation or cancellation, without duplicate capture or lost successful groups. These checks do not measure model grouping accuracy or live Gmail/provider behavior.

Remaining acceptance work includes the product UI with three inspected visual variants, browser journeys, further changed-group/regression cases, and the approved motivating v2 workflow followed by bounded live selected-email verification. Actual expert approval is required before live refreeze or generation.
