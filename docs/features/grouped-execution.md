# Selected-email grouped execution

## Implementation status

The product UI, API, parent coordinator, grouping/aggregation phases, and fixture worker journeys are implemented on the grouped-execution branch. The motivating v2 process has been explicitly approved, reviewed and frozen, and its approved implementation has been generated. A live two-email run completed both groups and aggregation with inspected source isolation. Business accuracy remains unverified; execution completion does not establish customer readiness.

## Product experience

Open **Agent → Run workflow → Selected emails**. Choose the approved code version, search Gmail and select the relevant emails. **Select all results** loads every remaining results page and selects each matching email once; individual checkboxes and **Clear selection** allow adjustments. There is no email-count selection cap. No shipment reference is required. **Run selected emails** captures and starts the parent operation automatically. **Saved input** retains the existing single-run path.

The summary shows completed groups, groups needing attention and unresolved sources. Each group opens a neighboring inspector with its actual code version, output, step/audit history, human responses and recovery history. An accepted group repair is labeled as local to that group; it does not change the manual-run default. **Inspect code** opens that exact implementation. Questions about source assignment appear above the group list; their answers and prior coverage remain inspectable after reload.

Source coverage expands to show the scope and reason for every assignment, any unresolved portion and explicit exclusions, alongside shared spend/time limits. **Browse recent runs** lists runs for the selected frozen process version. Starting another run is disabled while the workflow has an active operation. Cancellation preserves completed groups and history; failed groups and partial combined reports remain visible. Reports are previews, and execution completion is not a claim of verified business correctness.

The results-first layout was selected after live comparison with sidebar and three-column alternatives. It places group selection beside the selected result on desktop and stacks them on smaller screens. Setup opens automatically when there is no run history.

## Input and execution

An engineer selects distinct email IDs and a generated implementation from an approved plan. The parent operation captures only those emails and their attachments. Capture publishes an immutable bundle only after all requested evidence is saved. The existing Gmail reader remains read-only. Removing the selection cap does not remove execution bounds: captures still enforce attachment/text/byte limits, and grouping still enforces its source/group, time and spend limits. A failed results-page fetch retains the loaded selection and reports that selecting all did not finish.

The approved Trigger implementation runs in explicit `grouping` mode through the normal step runner. Generation and repair guidance separate ownership reasoning from full downstream document extraction, require the exact grouping result shape, and require normal children to accept their established group without regrouping. These instructions guide generated code; runtime validation and live verification still determine whether it obeys them. It returns groups and one disposition for every captured source: scoped assignments, a clarification question for an unresolved portion, or an exclusion reason. Multiple emails can support one group, and one source can contribute to several groups. Host validation checks identities, ownership, bounds and coverage; it does not certify the semantic correctness of assignments.

Each group receives a separate sealed input bundle and ordinary child workflow run. The generated workflow owns business grouping rules and results. The parent owns scheduling, source coverage, shared limits and cancellation. Child jobs use the parent's operation slot rather than competing for independent top-level slots.

## Clarification and recovery

Questions and submitted answers retain their original wording. After the current questions are answered, regrouping receives a new sealed bundle containing the unchanged captured sources, prior decision and answers. The original bundle is not edited. Unchanged child inputs are reused; changed inputs produce linked successor children. Superseded active children are cancelled while their completed history remains available. Grouping permits at most three clarification rounds.

Implementation failures use the existing bounded run-recovery service, approved methods, build checks and any locked regression suite. Recovery preserves the source run's mode and input bundle. The parent exposes the actual accepted run/code version for each group or phase. Group-specific recovery does not promote a new default for unrelated manual runs. Completion without trusted evaluation remains explicitly unverified business output.

## Combined report

The approved Outcome implementation runs in `aggregate` mode after the current groups settle. With multiple Outcome blocks, the engineer selects the one that should create the combined report. The host passes each group's actual run/version/input references, status, output or error, plus grouping coverage. Generated aggregation must preserve unknowns and limitations rather than count missing or failed work as zero or success.

The host's overall execution status is separate from the business summary. A parent succeeds only when source coverage is complete, every current child completes, and aggregation completes. Partial reports remain inspectable when independent work fails. A negative business result is not itself an execution failure.

## Bounds and persistence

Migration 017 adds parent job ownership, grouped captures, immutable decisions/child provenance, clarification questions, durable inference reservations and expiring activity-capacity leases. One parent owns the workflow's active-operation slot. Two heavy activities share capacity, including resumed human steps; pauses do not hold a capacity lease. Applied limits and original captured input cannot change.

The parent retains a shared active-time ledger, a wall deadline and a $5 inference allowance. Group/repair reservations compose with any operator-level budget. Unknown provider outcomes retain their reservations across restart. Each run and repair also retains its existing bounds. Parent cancellation fences late publication, closes pending questions and preserves completed results; Temporal requests cancellation of active children. The parent also redelivers persisted child cancellation requests when direct notification is missed.

## API and module boundaries

- `GET/POST /api/workflows/:id/grouped-executions`: list version-scoped history or start selected-email execution.
- `GET /api/workflows/:id/grouped-executions/:jobId`: group results, coverage, clarification and provenance.
- `POST /api/workflows/:id/grouping-questions/:questionId/answer`: immutable, idempotent clarification response.
- Existing job cancellation and run/human-response endpoints remain the action boundaries.

Browser state and inspection controls live in `src/components/grouped-execution`, reusing the Gmail picker, human-response forms, recovery panel and audit viewer. Domain contracts live in `src/domain/grouped-execution.ts`. Parent services, state projection, budgets and capacity live in `src/server/grouped-execution`. Durable orchestration lives in `src/worker/grouped-workflow.ts`; provider/capture work remains in activities and existing integrations.

## Verification and remaining work

`grouped-runtime.test.ts` exercises immutable capture/limits, source validation, clarification-derived inputs, unchanged-child reuse and changed-child supersession, partial aggregation, cancellation, shared capacity and recovery-version provenance. `grouped-worker.test.ts` uses a real local Temporal server with sanitized adapters and actual persistence to verify restart followed by human continuation, parent cancellation or persisted child cancellation, without duplicate capture or lost successful groups. These checks do not measure model grouping accuracy or live Gmail/provider behavior.

`grouped-execution.spec.ts` checks email selection/start without a shipment reference, actual-version inspection, clarification persistence after reload, human responses, cancellation, retained successes, partial reports and a mobile viewport. Existing manual-run/recovery journeys still exercise the Saved input path.

The expert approval and v2 freeze/generation gates have been completed. Live run `28f36737-78b8-4040-b8b2-64ac31f2d770` completed two selected emails as two isolated groups using v10, with no repairs during that run. All 15 captured sources were accounted for (12 assigned, three excluded decorative images, zero unresolved); sealed child membership and document hashes matched the selected capture. Earlier timeout, contract, citation and spending-limit failures remain visible along with their partial reports.

The combined report sums the two child outputs and preserves their provenance and explicit unverified status. Inspection found a generated reporting bug: the presence of any coverage object made totals partial even when coverage was complete. A locked five-case Outcome suite reproduces that defect without PDF reads (baseline 3/5 cases, 13/15 assertions). These report-only checks are separate from extraction/validation accuracy. The selected emails omit a later certificate reply for one group, so these business results must not be compared directly with full-shipment labels.

The standard repair session then accepted v14 on its first attempt after three consecutive complete passes of those five cases (15 assertions each). Only the generated aggregate completeness condition changed. A sandbox replay of the real saved aggregate input changed `partial` to false and preserved every other output field, without rereading PDFs or invoking a model. Earlier reports remain immutable. This verifies the report defect’s repair, not end-to-end accuracy of v14 on new emails.
