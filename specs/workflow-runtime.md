# Trusted workflow runtime

## Scope and entry

The API accepts a code version, sealed input bundle, and request key for a manually started execution. Code and inputs must belong to the workflow. The request and run are created atomically; duplicate requests return the same operation, while a reused key with different inputs is rejected. A queued/running/waiting/cancelling operation prevents another expensive operation on that workflow.

The current UI displays execution operations through the shared operation banner/history and can cancel them. Dedicated run, trace and response controls are not implemented yet. The runtime APIs are `/workflows/:id/input-bundles`, `/runs`, `/runs/:runId`, and `/human-requests/:requestId/answer` under `/api`.

## Input and history

Input bundles contain immutable input JSON, message identifiers and ready source-artifact references. Artifact ownership is checked before sealing. Different documents require another bundle. This feature supports fixture capture; actual Gmail retrieval is a later adapter.

A run pins its code and input bundle. A block definition and a visit are distinct: loops create a new occurrence and node visit number. Outputs and selected connections are saved per visit. Completed steps, terminal runs and sealed inputs cannot be rewritten. The most recent 20 runs are listed; a selected run exposes its ordered, bounded trace and human requests.

## Methods, routing and human responses

The approved method cannot change during execution. Code returns structured output. Agent may request one bounded interpretation and must complete on its second invocation. A Human step pauses before any candidate invocation, accepts text or an approval decision, then runs response handling. It requires a fresh response on every visit; identical request-key retries are idempotent and conflicting late responses are rejected.

Generated code reports matching outgoing connection IDs. The trusted service rejects foreign, duplicate and Otherwise IDs, then enforces the frozen routing rule. Multiple matches at an exclusive split fail. No matches use a single Otherwise route if present, or fail. A parallel split runs all declared branches and joins only after all arrive at its paired merge for that occurrence.

## Failures and limits

A branch failure stops new downstream scheduling and prevents an incomplete merge. Already-running independent steps can retain their output. Pending human requests that no longer lead to completion are cancelled. Explicit cancellation fences late output and stops isolated invocations; completed history remains.

Each run records 100 scheduled attempts and a 900-second active-time limit. Human-only waiting is excluded; a running parallel sibling keeps the clock active. Limits produce Needs attention. A successful business report may contain failed goods: successful execution is separate from successful business validation or evaluation.

Retry creates a fresh run with the original code and inputs, linked to the finished run. It never imports previous approvals or resumes halfway. Report sending, mutable in-run documents and arbitrary external actions are unsupported. Locked evaluation cases and repair sessions are not implemented by this feature.
