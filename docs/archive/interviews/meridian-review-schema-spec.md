# Meridian review schema

> Archived interview/design record. Some proposed tables and execution responsibilities were intentionally superseded during implementation. Start with the [documentation index](../../README.md) and [current data-model audit](../../architecture/data-model.md); executable fields and constraints live in [migrations](../../../app/migrations).

October 7, 2026. Design proposal; no migration has been executed. Extends the [canvas schema](meridian-canvas-schema-spec.md).

## Recommendation

Use four tables: `review_runs`, `discussion_threads`, `discussion_messages`, and `thread_anchors`. A finding is a kind of discussion thread, rather than a separate conversation system. Customer notes share the same replies and anchors without blocking freeze. A review's clarification conversation also uses a thread, avoiding a second message-storage format.

This replaces the earlier candidate `findings` and `finding_anchors` tables. Domain concepts remain distinct even where storage is shared.

## Fields

Unless marked optional, fields are required. IDs are UUIDs; times are `timestamptz`. Text enums below are validated with constraints. Each workflow-owned table also has `UNIQUE(workflow_id, id)` for same-workflow foreign keys.

### `review_runs`

| Fields | Type / meaning |
| --- | --- |
| `id`, `workflow_id` | UUID primary key; workflow foreign key |
| `status` | `queued`, `running`, `awaiting_customer`, `completed`, `cancelled`, or `failed` |
| `phase` | `clarification` or `analysis`; separate from job status |
| `started_content_revision` | Bigint identifying the draft when review was requested |
| `initial_snapshot` | Immutable JSON object: starting graph and desired outcome |
| `analyzed_content_revision`, `analyzed_snapshot` | Optional bigint / JSON object; exact input used for the published findings, including the confirmed goal |
| `model`, `model_settings` | Model identifier and JSON object of generation settings; use the actual model configuration, not only a marketing label |
| `reviewer_version` | Application/prompt revision identifying review behavior; optional until execution starts, then required and immutable |
| `error_code`, `error_message` | Optional structured failure category and readable explanation |
| `created_at`, `started_at`, `finished_at` | Creation required; start/end optional until those events occur |

Keep starting and analyzed input separate because a missing goal may be confirmed during clarification. These snapshots are intentionally duplicated at a version boundary, not rewritten on every canvas edit. Seal analyzed input before final analysis and verify its content revision before publication. A completed review requires analyzed input and a finish time; cancelled/failed reviews also require a finish time. They do not count toward the minimum completed-review requirement.

One review uses one configured model for the demo. Retrying transient model requests may happen within the same run; restarting a terminal failed/cancelled review creates a new run and preserves its predecessor's history. Clarification answers remain available as context but must be checked for relevance to the new draft.

### `discussion_threads`

| Fields | Type / meaning |
| --- | --- |
| `id`, `workflow_id` | UUID primary key and workflow foreign key |
| `kind` | `finding`, `note`, or `clarification` |
| `title` | Short display summary; detailed rationale lives in the initial message |
| `scope` | `workflow` or `elements`; prevents a deleted target from accidentally becoming a workflow-wide comment |
| `origin_review_run_id` | Optional UUID; required for findings and clarification, absent for customer notes |
| `finding_category` | Optional text; required for findings. Initial categories: ambiguity, missing behavior, inconsistency, simplification |
| `status` | `open` or `closed`; only open findings block freeze |
| `resolution_kind`, `resolution_note`, `closed_at` | Current disposition, explanation, and time; optional while open |
| `previous_finding_id` | Optional same-workflow thread reference for a new concern caused by a material change; target must be a finding |
| `proposed_node_id`, `proposed_node_revision`, `proposed_patch` | Optional atomic group: same-workflow node reference, expected bigint revision, validated JSON field edits |
| `revision` | Positive bigint for stale disposition/proposal changes |
| `created_at`, `updated_at` | Timestamps |

Findings close with `workflow_updated`, `clarified`, `rejected`, or `target_deleted`. Clarified/rejected findings require a nonblank explanation. Updated findings may have an optional explanation; Apply and resolve records the actual applied fields automatically. Target-deleted closure records its system reason. Notes can be closed without finding-specific resolution fields. A clarification thread closes when its review terminates; this is controlled by the review transition, not an independent customer decision.

A customer can reopen a finding while the workflow is a draft. Append the reopening event and clear its current closure fields; the previous closure remains in history. AI cannot reopen a finding. Frozen boards and their review decisions are locked for the demo.

Proposal fields are absent for graph changes, including removal suggestions. For the first implementation, allow title/instruction edits; permit structured config fields only after their per-type edit rules are defined. Do not accept arbitrary JSON Patch, node deletion, type changes, routing edits, or unchecked config replacements through this feature. Suggestions are stale when their target node revision changes; do not silently rebase them. Context involving other nodes should remain visible for customer judgment.

### `discussion_messages`

| Fields | Type / meaning |
| --- | --- |
| `id`, `workflow_id`, `thread_id` | UUID identity and same-workflow thread reference |
| `message_number` | Positive bigint giving deterministic order within the thread; allocated under the thread lock |
| `parent_message_id` | Optional reference to an earlier message in this same thread; supports replies as a tree |
| `author_kind` | `customer`, `ai`, or `system`; descriptive attribution, not a permissions model |
| `kind` | `comment` or `event` |
| `body` | Readable comment, question, rationale, answer, or event summary |
| `event_data` | Optional JSON object; required for lifecycle events, absent for ordinary comments |
| `source_review_run_id` | Optional same-workflow review provenance, including follow-up from a later review into an existing finding |
| `request_key` | Idempotency key unique within the thread, so a retried submission does not duplicate a message/event |
| `created_at` | Timestamp |

Lifecycle events preserve closure, reopening, applied edit, and goal-confirmation details. Event payloads are constructed by the server from the successful operation; clients cannot assert that an edit was applied by posting event JSON. Current thread fields support fast queries, while immutable events preserve earlier decisions. For the demo, append messages rather than implementing comment editing/deletion.

Use a same-thread composite foreign key for parent messages and validate that the parent has a lower message number. Message IDs are not a linked list; replies can share the same parent. AI messages generated in a later review reference that later run without changing the thread's original review identity.

### `thread_anchors`

| Fields | Type / meaning |
| --- | --- |
| `id`, `workflow_id`, `thread_id` | UUID identity and same-workflow thread reference |
| `node_id`, `connection_id` | Optional UUIDs, with exactly one populated |
| `context_snapshot` | JSON object preserving the relevant label/excerpt when anchored; historical context survives later edits or logical deletion |
| `created_at` | Timestamp |

Use same-workflow foreign keys to nodes/connections. A thread may anchor several graph elements; prevent duplicate anchors to the same element. Workflow-scoped threads have no anchors. Element-scoped threads require at least one, created with the thread in a controlled transaction. Clarification threads are workflow-scoped. Keep anchors after logical deletion so the interface can show what was removed.

Confirmed deletion rule: an open finding whose sole referenced block is deleted closes automatically. Multi-target findings with other surviving targets remain open; previously closed decisions keep their original meaning. Recommended extension for consistency: use the same target-deleted reason when no targets survive, including connection-only findings. This extension is not an independently confirmed interview decision; until adopted, leave those findings for explicit resolution rather than dropping them.

## Workflow lock and indexes

Add nullable `workflows.active_review_run_id`. A composite foreign key from `(workflows.id, active_review_run_id)` to `review_runs(workflow_id, id)` prevents linking another workflow's review. Enforce that `state = reviewing` exactly when this pointer is populated. Maintain the pointer and review status together in controlled transactions; a pointer alone cannot prove the referenced run is still active.

Recommended indexes beyond primary/composite keys:

- One active review per workflow: unique partial index on `review_runs(workflow_id)` for queued/running/awaiting-customer states.
- Latest completed review: `(workflow_id, finished_at DESC, id DESC)` filtered to completed runs. No independently maintained last-review pointer is needed.
- Freeze gate: `discussion_threads(workflow_id)` filtered to open findings.
- Workflow thread list: `(workflow_id, updated_at DESC, id DESC)`.
- One clarification thread per review: unique `origin_review_run_id` filtered to clarification threads.
- Messages: unique `(thread_id, message_number)` for pagination/order; unique `(thread_id, request_key)` for retries; `(thread_id, id)` uniqueness for same-thread reply references.
- Anchors: unique `(thread_id, node_id)` and `(thread_id, connection_id)` where populated; `(workflow_id, node_id)` and `(workflow_id, connection_id)` for affected-thread lookup on edits/deletion.

Relationships such as a linked thread being of kind finding and element-scoped threads having anchors require transactional validation or constraint triggers. Ordinary row checks cannot verify another row's kind or count its children. Do not expose direct client writes that bypass these checks.

## Operations and failure behavior

1. **Start review:** lock the workflow, require draft state, create the run and initial snapshot, attach its active pointer, and set reviewing state together. Normal canvas writes are rejected while it runs.
2. **Clarify:** save questions/answers in the run's clarification thread. A customer-confirmed missing goal can update the workflow through this active review, advancing content revision and recording the change. Then seal the analyzed snapshot/revision. Further changes require returning to clarification and a fresh analysis input; do not publish analysis of an earlier goal as current.
3. **Publish:** validate the AI result, then in one transaction verify active run identity and analyzed content revision, create findings/anchors/messages or append follow-ups to existing open findings, mark the review completed, and unlock the workflow. Proposed edits remain unapplied. Existing closed findings cannot be reopened by this operation. A genuinely new issue caused by changed content receives a new linked thread.
4. **Cancel/fail:** retain saved conversation, mark the run terminal, close its clarification thread if present, and clear the pointer/unlock only if it is still the active run. Late workers must fail the identity/status checks. Recommended publication behavior: do not expose partially generated finding batches; a failed review does not modify the existing finding set. A bounded job-failure recovery mechanism must also release abandoned review locks; awaiting customer input is not a worker failure.
5. **Apply and resolve:** require draft state, lock the workflow and affected records, check expected thread and node revisions, validate the allowed patch, apply the edit, advance content revision, close the finding, and append its event together. A failed check rolls back the whole operation and preserves the customer's unsaved input. Ordinary manual resolution makes no unverified claim that AI approved the change.
6. **Reopen:** customer action while draft; append the previous disposition and reopening event, set open, and increment thread revision. It blocks freeze again. A repeated request key returns the existing result rather than creating another event.
7. **Freeze:** require at least one completed review, zero open findings, and a structurally valid graph. Compare the latest completed review's analyzed content revision with the draft; require acknowledgment when they differ. Notes do not block freeze. Snapshot the relevant review decisions, goal, graph, and acknowledgment before locking the handoff. The assignment demonstration still shows at least two review rounds.

The same short workflow-row lock orders graph edits, review publication, finding dispositions, and freeze. Do not hold a database transaction open during model execution. Semantic duplicate detection across reviews is not solved by an idempotency key: provide existing findings to the reviewer, require explicit existing-thread references for follow-ups, and validate those references. Publication retries must also be idempotent.

## Confirmed in this round

- Explicit Apply and resolve for safe detail edits, with stale-edit protection and atomic persistence.
- Customer-created note threads; only AI findings block freeze.
- Customer reopening before freeze, with previous resolutions retained. No AI reopening or post-freeze reopening in the demo.
- At least one completed AI review before freeze; unreviewed later edits retain the existing acknowledgment behavior.

Remaining implementation choices include the worker's retry/timeout mechanism and exact model-output/config validators. These do not require inventing new business entities now. Next schema portion: implementation plans, code versions, evaluations, and repair sessions.
