# Workflow execution

The trusted runtime runs the frozen graph against one immutable input bundle and code version. Its API creates a durable operation, exposes ordered step history, accepts a human response, and permits cancellation. Open Agent → Run workflow in the engineer workspace. Select an implementation and saved input packet, or capture related Gmail emails. Start run begins execution; the input controls remain disabled while another workflow operation is active.

Temporal owns scheduling, parallel joins, active-time timers, and human waits. Postgres stores application progress and history. Each visit has a scheduling key and per-node visit number; a retry within that visit uses a fresh fencing token. Completed outputs are reused on duplicate delivery. An obsolete invocation cannot overwrite a completed, cancelled, or superseded attempt.

The server obtains a human response before invoking a Human implementation. Agent implementations may request one bounded OpenAI interpretation, then must complete. Code implementations cannot request tools. Vercel Sandbox runs each invocation in a fresh Node 24 VM with denied network access, no application credentials, a 20-second process timeout and bounded output. The server checks output shape and outgoing routes; the candidate cannot schedule arbitrary nodes.

An exclusive split requires exactly one matching route, or its Otherwise fallback on zero matches. Each parallel branch sees the shared split context plus its own path outputs until the merge. A parallel split starts its declared branches, waits for the paired merge, and creates a separate join on every visit. A failed branch stops new downstream work; already-running siblings may finish for diagnosis. Overlapping and nested parallel sections are rejected at freeze.

Runs record fixed limits of 100 scheduled attempts and 900 active seconds. Infrastructure redelivery can invoke a visit at most twice and consumes an additional attempt. Active time includes automated work and backoff across parallel branches, without summing their durations. It pauses only when all remaining paths await a human. Exceeding a limit needs attention; it is never successful completion. A fresh retry retains the same code and captured inputs, links to the old run, and carries no previous approvals.

## Verify

From `app/`, run `npm test` and `npm run worker:check`. These are in CI and do not need provider credentials. Runtime tests cover route ambiguity, Otherwise, fresh human visits, per-occurrence joins, parallel failure, active-time accounting, immutable history, duplicate delivery, ownership, and late-result fencing.

With configured Supabase, Temporal, and Vercel Sandbox, apply migrations and start the worker. `npm run runtime:smoke -- --live --leave-waiting` creates a clearly synthetic three-step workflow using deterministic fixture source, executes it in Sandbox, and reports the waiting run ID. Stop the worker, run `npm run runtime:smoke -- --live --resume <run-id>`, then restart the worker. The response is persisted while offline and delivered from the outbox; the command verifies completion. This smoke check does not call the generator, retrieve Gmail, or send email.

Live verification on October 7: run `8f8debcc-95ce-4baa-a2f6-ec0b73de3111` completed all three steps after worker restart, with one persisted approval. The run is synthetic and is not shipment-accuracy evidence.

## Inspect and respond

The input sidebar keeps code/input selection next to the selected run. Recent runs shows manually started runs; evaluation case traces remain in Evaluation. A run displays its code version, input label, status, visit history and applied limits. The step-history disclosure exposes per-visit inputs, outputs, errors and human responses.

A Human step presents the frozen question with text entry or Approve/Reject controls. Submission records the response for that visit, then the worker resumes. A subsequent visit asks again. Ordinary inspection remains available while an operation is active; cancellation uses the shared operation control.

Completed outcomes show the full JSON result. When the outcome contains a report with a subject and body, the screen also renders a plain-text Report preview, recipient if supplied, and “Not sent.” Numeric totals are displayed with their supplied labels. There is no sending control. Retry same inputs creates a new linked run with the same implementation and input packet; earlier approvals are not reused.

Verification: the required browser journey uses sanitized HTTP fixtures for Gmail selection/capture, approval, report rendering, narrow layout and fresh-approval retry. This checks UI behavior, not live orchestration. Separately, a real synthetic run on October 7 was started from this screen, paused for an approval, and completed all three steps after the response was submitted through the UI.

## Implementation contract

### Scope and entry

The API accepts a code version, sealed input bundle, and request key for a manually started execution. Code and inputs must belong to the workflow. The request and run are created atomically; duplicate requests return the same operation, while a reused key with different inputs is rejected. A queued/running/waiting/cancelling operation prevents another expensive operation on that workflow.

The Agent tab includes manual run controls, ordered traces and human response forms; the shared operation banner supports cancellation. The runtime APIs are `/workflows/:id/input-bundles`, `/runs`, `/runs/:runId`, and `/human-requests/:requestId/answer` under `/api`.

### Input and history

Input bundles contain immutable input JSON, message identifiers and ready source-artifact references. Artifact ownership is checked before sealing. Different documents require another bundle. [Gmail capture](gmail-inputs.md) supplies real packets; CI uses sanitized fixtures.

A run pins its code and input bundle. A block definition and a visit are distinct: loops create a new occurrence and node visit number. Outputs and selected connections are saved per visit. Completed steps, terminal runs and sealed inputs cannot be rewritten. The most recent 20 runs are listed; a selected run exposes its ordered, bounded trace and human requests.

### Methods, routing and human responses

The approved method cannot change during execution. Code returns structured output. Agent may request one bounded interpretation and must complete on its second invocation. A Human step pauses before any candidate invocation, accepts text or an approval decision, then runs response handling. It requires a fresh response on every visit; identical request-key retries are idempotent and conflicting late responses are rejected.

Generated code reports matching outgoing connection IDs. The trusted service rejects foreign, duplicate and Otherwise IDs, then enforces the frozen routing rule. Multiple matches at an exclusive split fail. No matches use a single Otherwise route if present, or fail. A parallel split runs all declared branches and joins only after all arrive at its paired merge for that occurrence.

### Failures and limits

Runtime and evaluation activities tolerate a 60-second gap in delivered heartbeats. They emit every five seconds, and the worker caps heartbeat throttling at five seconds. This gives brief connectivity interruptions room to recover without repeating business work. The 150-second invocation abort, three-minute activity deadline, seven-minute total retry deadline, two-attempt allowance and run limits remain unchanged. Cancellation still uses heartbeat delivery; a disconnected worker may take longer to observe it, while database fencing rejects late publication.

A branch failure stops new downstream scheduling and prevents an incomplete merge. Already-running independent steps can retain their output. Pending human requests that no longer lead to completion are cancelled. Explicit cancellation fences late output and stops isolated invocations; completed history remains.

Each run records 100 scheduled attempts and a 900-second active-time limit. Human-only waiting is excluded; a running parallel sibling keeps the clock active. Limits produce Needs attention. A successful business report may contain failed goods: successful execution is separate from successful business validation or evaluation.

Retry creates a fresh run with the original code and inputs, linked to the finished run. It never imports previous approvals or resumes halfway. Report sending, mutable in-run documents and arbitrary external actions are unsupported. [Evaluations](trusted-evaluations.md) and [repair](bounded-repair.md) reuse this runtime under their owning operation.

### Manual run workspace

In the engineer workspace, Agent contains Code and Run workflow views. Run workflow presents implementation/input selection beside the current result and human requests, with a manual-run history. Capture from Gmail expands search, selection and a required shipment reference. Capture alone does not run the process.

Start run requires a code version and captured input and is disabled during the workflow's active operation. Human prompts appear per visit, accept text or explicit approval/rejection, and retain unsent text on errors. Completed runs expose the whole result and a plain-text, unsent report preview when supplied by the outcome. Retry same inputs preserves the previous run and starts a new one with fresh human responses. Evaluation case runs do not populate manual history.

## Execution audit

Each host invocation records immutable audit events: the initial generated result, the model request actually sent (instructions, data, model configuration and document hashes), the parsed model response before generated postprocessing, the postprocessing result, and a safe failure category/code when available. These records distinguish document selection, model extraction and consumer errors. They do not record hidden model reasoning, credentials, transport headers or provider error bodies. An interrupted request without a response remains incomplete evidence; old runs are not retroactively reconstructed.

Migration 010 adds `execution_audit_events`, scoped to either one workflow step occurrence or one isolated case result and its invocation token. Large event payloads use existing immutable `trace` artifacts with hash verification. Indexed metadata is fetched when the engineer opens Execution audit; payloads load on demand. The host writes events outside model/sandbox work and rechecks ownership under the workflow lock before publishing the event. Cancellation and superseded attempts cannot append late events. Unlinked artifacts from an interrupted upload/publication can remain for future retention cleanup.

The same audit records are available to the repair agent through a bounded read-only tool. Full payloads stay stored; a tool response over 48 KB is explicitly shortened, and JSON paths select smaller subtrees. Audits never modify assertions or determine acceptance. Event payloads are capped at 2 MB and each host invocation at six events; current execution produces at most five. Two infrastructure invocations per visit remain the existing limit. Failure to persist the audit is an infrastructure error, not a generated-code defect.

Read-only APIs: `GET /api/workflows/:id/audit-events?step_execution_id=...` (or `case_result_id=...`) lists one invocation owner's events; `GET /api/workflows/:id/audit-events/:eventId` retrieves an owned, integrity-checked payload. The UI preserves the existing trace layout with expandable audit details. Source bytes remain in captured artifacts rather than being copied into every event.

## Evidence-aware extraction

An approved Agent can request structured extraction for decision-relevant document fields. The generated implementation defines the output shape and which scalar fields need evidence; the platform contains no shipment-specific field names or matching rules. Each field retains its printed value, normalized value, status, source artifact/page, supporting quote or box when found, and explanation when missing or uncertain.

The host checks schema conformance, field coverage, normalized-value consistency, captured-document membership, actual PDF page bounds, and bounding-box bounds. A bare null cannot establish absence. Unresolved or unreadable evidence stops execution before business validation and appears as an extraction error; it does not silently count as a failed good or missing document. Raw responses and bounded field issues remain in Execution audit. Structurally valid citations are still model claims: these checks do not establish that a quote is true or the model found every record. Independently verified cases remain necessary.

The first provider uses the existing OpenAI document interpreter. Existing implementations keep their earlier reasoning contract until regenerated or repaired to request extraction; this addition does not retroactively improve historical versions. Automatic reinspection and alternate-provider comparison are not part of this checkpoint.

Extraction output schemas must use synchronous validation. Asynchronous schemas are rejected before a provider call, alongside references and regular expressions, so a validation Promise cannot bypass the output contract.

## Bounded document batches

An approved Agent module can return `extract_batch` with one to five ordinary `extract` requests. Each request retains the existing 20-document/20-MB bounds and evidence validation. Requests execute sequentially under the bounded step deadline and inference spending guard. The host records each request and response with a zero-based `batch_index` (migration 017 allows up to 13 audit events per invocation). No model can choose additional requests or alter the frozen graph.

After every batch validates, the module receives `tool_result.batches` and `extraction_evidence.batches` in request order. Generated code owns any business-specific merge, deduplication and evidence-path remapping. Combined data/evidence are limited to 400 KB and final step output remains limited to 128 KB. A failed batch stops the interaction with retained audit evidence; no partial report is published. No field validation is relaxed, no documents are silently truncated, and a larger document set may still exceed the time/byte/output limits. Existing single-request modules behave as before. The capability is recorded in new evaluation configurations, so prior-policy runs cannot contribute to new repeatability confirmation.

## Extraction deadlines

Token counting retains its separate 120-second shared preflight limit. Once counting and spend reservation finish, each runtime OpenAI response gets 180 seconds for both response headers and the complete body. `MODEL_RESPONSE_TIMEOUT` records the stage, allowance and elapsed time in the failure audit and repair evidence. Partial responses never reach postprocessing. The transport is aborted; uncertain charges stay reserved. Runtime model calls disable SDK retries, and this timeout is not eligible for automatic case replay. Quota and spending failures still stop without repair.

One step, including sequential extraction batches, has a 12-minute activity-side cap and a 12.5-minute Temporal start-to-close cap. The existing 15-minute active run limit remains authoritative and can cancel a step earlier. The heartbeat timeout remains 60 seconds. User cancellation takes priority; an exhausted step allowance becomes `STEP_EXECUTION_TIMEOUT`, not a generic worker failure or an automatic repeat of paid work. Isolated step evaluations retain the same diagnosis. New evaluations record these policies; old configurations cannot contribute to a new confirmation sequence. These allowances improve failure handling, not extraction accuracy, and a slow provider can still exhaust them.

Runtime model audit summaries retain bounded provider-stage durations (preflight, reservation, response, usage reconciliation), token counts when available, reservation IDs and known costs. Document count/bytes and extraction page counts accompany model requests. These contain no source text, provider error bodies, credentials or headers. Concurrent interactions have isolated trace contexts. A reservation records possible cost, not proof that a call completed or was billed. Response deadlines apply to runtime interpretation only; code generation and repair keep their own longer operation allowances.

Known worker failures carry their category through Temporal wrappers. A completed extraction validation diagnosis remains an implementation failure even if the surrounding deadline expires concurrently; unknown failures still require investigation. Isolated-case fallbacks preserve typed diagnoses as well. This classification allows actual implementation failures to reach repair without treating quota, timeouts or budget exhaustion as code defects.

After every batch validates, the module receives `tool_result.batches` and `extraction_evidence.batches` in request order. Generated code owns any business-specific merge, deduplication and evidence-path remapping. Combined data/evidence are limited to 400 KB and final step output remains limited to 128 KB. A failed batch stops the interaction with retained audit evidence; no partial report is published. No field validation is relaxed, no documents are silently truncated, and a larger document set may still exceed the original time/byte/output limits. Existing single-request modules behave as before. The capability is recorded in new evaluation configurations, so prior-policy runs cannot contribute to new repeatability confirmation.

## Automatic implementation recovery

Classified implementation failures hand off atomically to [bounded run recovery](bounded-repair.md#recovery-from-a-failed-manual-run). Existing failures can be diagnosed explicitly. A recovery rerun keeps the original captured input, uses its candidate code, and requests new human responses. Completed negative business results remain ordinary report outcomes. An accepted recovery becomes the visibly unverified manual-run default; Retry same inputs still uses that selected historical run's original code and bundle.
