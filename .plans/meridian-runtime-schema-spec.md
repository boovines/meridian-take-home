# Meridian execution and artifact schema

October 7, 2026. Original design proposal. Implementation checkpoint: migration 007 now implements captured inputs, manual runs, visits and human responses. Temporal owns parallel coordination, so conditional parallel tables are omitted and step `branch_ref` replaces `branch_id`. See `docs/workflow-runtime.md` for executable behavior and remaining evaluation work. Completes the main schema interview and extends the [engineering schema](meridian-engineering-schema-spec.md).

## Recommendation

Keep inputs and code immutable, and represent each execution separately. A canvas node is a definition; a step occurrence is one visit to it. A parallel join belongs to one split occurrence, and a human response belongs to one step occurrence. These distinctions prevent old outputs or approvals from being reused accidentally through loops.

Use the same top-level job mechanism for manually started shipment runs and generation/evaluation/repair. The engineering schema's `engineering_jobs` is renamed `workflow_jobs`; do not implement both tables. Add `execution` as a kind and `waiting_for_human` as a status. Recommended demo simplification: manual runs share the one-active-operation-per-workflow slot. Waiting for a human keeps that slot but releases the worker; cancel the run before starting another operation. Evaluation-case executions are children of the existing evaluation/repair job, not additional top-level jobs.

The trusted runtime controls routing, budgets, human gates, and parallel coordination. Generated handlers implement step behavior and condition evaluation through validated input/output contracts; they cannot bypass a required human step by returning a different graph.

## Fields and relationships

IDs are UUIDs; times are `timestamptz`. Each table has an `id` primary key, `workflow_id`, and `created_at`. Mutable records also have `updated_at`. `?` means nullable. Use same-workflow foreign keys and validate membership in the run's exact frozen graph. Same-run references must not cross executions merely because they belong to the same workflow.

Define `UNIQUE (workflow_id, id)` on workflow-owned reference targets. Add `UNIQUE (run_id, id)` to step executions, parallel groups, and branches so composite foreign keys can enforce same-run membership. Human requests reference `(run_id, step_execution_id)`; groups reference their split and optional merge occurrences in that run; branches reference their group and optional arrival occurrence in that run. Nullable references are checked when present. Cross-record lifecycle rules still require controlled mutations.

### `artifacts`

- `kind text`: source document, generated project, evaluator, trace, report, or step payload
- `state text`: pending, ready, or failed
- `storage_key text`, `content_hash text?`, `byte_size bigint?`, `media_type text`
- `display_name text`, `metadata jsonb`, `ready_at timestamptz?`

The database stores identity, ownership, and metadata; object storage stores file bytes. Keep stable object keys, not expiring signed download URLs. Stage uploads first, verify ownership/content/hash/size, then mark ready. Once ready, content and identifying metadata are immutable; create a new artifact for changed bytes. No run or locked suite may reference a pending artifact. Retain artifacts referenced by history; garbage collection and deletion UI are outside demo scope. Credentials never belong in artifacts or generated source.

### `input_bundles`

- `source_kind text`: gmail or fixture for the demo
- `manifest jsonb`, `manifest_hash text`
- `shipment_reference text?`

An immutable manifest describes the exact selected messages, email-body artifacts, attachment artifacts, and source identifiers captured for a run. Preserve original filename/message associations even if content is duplicated. Validate every artifact reference as ready and belonging to the same workflow before sealing the manifest. This owned collection is consumed as a whole and has no per-item edits, so a separate mutable bundle-item table is unnecessary initially. JSON references require explicit validation; they do not acquire foreign-key protection automatically.

Gmail ingestion captures existing messages before execution. Once a run starts, it reads its captured bundle rather than silently fetching changed attachments on each retry. A changed document creates a new bundle and a new run. Fixture bundles use the same representation. Artifact IDs, message IDs, shipment references, invoice numbers, and batch numbers are different identifiers and must not be conflated.

### `workflow_runs`

- `job_id uuid`, `implementation_version_id uuid`, `input_bundle_id uuid`
- `kind text`: manual or evaluation
- `evaluation_case_result_id uuid?`, `rerun_of_id uuid?`
- `status text`: queued, running, waiting_for_human, completed, failed, needs_attention, or cancelled
- `limits jsonb`, `scheduled_step_attempts bigint`
- `active_elapsed_ms bigint`, `active_since timestamptz?`
- `result_data jsonb?`, `report_artifact_id uuid?`
- `failure_category text?`, `failure_code text?`, `failure_message text?`
- `started_at timestamptz?`, `finished_at timestamptz?`

The code version determines the approved plan and frozen spec; validate that it belongs to this workflow. Evaluation runs additionally reference their case result; at most one execution is attached to a given case result, and its code/bundle must match that case evaluation. Repeating a suite creates new results and executions. Direct unit tests do not require workflow runs.

Enforce uniqueness of nonnull `evaluation_case_result_id`. Require it for evaluation-kind runs and exclude it for manual runs. Match the code to its parent evaluation and the input bundle to the selected suite case's `input_bundle_id`; these are separate relationships. A retry must reference an earlier same-workflow run with the identical code version and bundle.

Completion describes execution, not the business outcome. A successfully produced report can state that goods failed validation. Parser crashes and ambiguous routing are execution failures. Record a distinct needs_attention result for exhausted execution budgets; neither it nor a waiting/cancelled run is a success.

### `step_executions`

- `run_id uuid`, `node_id uuid`, `occurrence_number bigint`, `node_visit_number bigint`
- `scheduling_key text`, `branch_id uuid?`
- `status text`: queued, running, waiting_for_human, completed, failed, or cancelled
- `input_data jsonb`, `output_data jsonb?`, `selected_connection_ids jsonb`
- `attempt_token uuid?`, `attempt_history jsonb`, `trace_artifact_id uuid?`
- `failure_category text?`, `failure_code text?`, `failure_message text?`
- `started_at timestamptz?`, `finished_at timestamptz?`

Unique `(run_id, occurrence_number)` and `(run_id, scheduling_key)`. Allocate occurrence numbers atomically; they identify scheduling events, not a promise about parallel completion order. A new loop visit gets a new occurrence. Retries within one visit stay on that occurrence with bounded attempt metadata. Large payloads use artifact references inside the small structured input/output envelope.

An idempotent scheduling key identifies a specific transition/branch arrival, never just a node ID. Claims and completions verify job and attempt tokens so duplicate workers cannot publish twice. Validate selected connections against this occurrence's node and frozen graph. The runtime enforces exactly-one matching route or explicit Otherwise; the generated handler does not choose arbitrary destinations.

`occurrence_number` orders scheduling events across the run. Add unique `(run_id, node_id, node_visit_number)` for visits to a particular node; retries within that visit keep its number. Allocate the per-node number under run scheduling coordination. Fixtures reference `(node_id, node_visit_number)`, never the global occurrence number, whose value can depend on independent parallel scheduling. Structured branch validation must prevent simultaneous visits to the same node from unrelated branches before their paired merge; otherwise a richer branch-qualified fixture address is required and is outside the current contract.

### `human_requests`

- `run_id uuid`, `step_execution_id uuid`
- `response_type text`: text or approval
- `prompt text`, `status text`: pending, answered, or cancelled
- `response jsonb?`, `response_source text?`: human or fixture
- `response_request_key text?`, `answered_at timestamptz?`, `cancelled_at timestamptz?`

Unique `step_execution_id` for the demo's one response per visit. Capture the prompt as presented. Save a response and its continuation atomically: lock the request, check it is pending and its run remains eligible, validate the response, mark answered, and enqueue/record the continuation once. A repeated identical request key returns the original result; a conflicting late response is rejected.

Each later visit, including in a fresh retry run, requires a fresh response. Approval reuse is out of scope. Responses contain text or approval/rejection, never document uploads. Evaluation responses come from locked case fixtures indexed by node and visit; mark them as fixture-supplied. A missing scripted response produces a diagnostic case error rather than waiting for a real person inside an autonomous evaluation.

### `parallel_groups`

- `run_id uuid`, `split_step_execution_id uuid`, `merge_node_id uuid`
- `status text`: open, ready, merged, failed, or cancelled
- `merge_step_execution_id uuid?`

Unique `split_step_execution_id`; a group represents one visit to a parallel split. Its merge node must be the one paired in the frozen definition. Derive enclosing context from the split occurrence's own branch. This supports correctly nested contexts without using a global “node completed” flag.

### `parallel_branches`

- `run_id uuid`, `group_id uuid`, `entry_connection_id uuid`
- `status text`: queued, running, arrived, failed, or cancelled
- `arrival_step_execution_id uuid?`, `output_data jsonb?`

Unique `(group_id, entry_connection_id)`. Materialize the expected branches from the split before scheduling them. Each member's progress is independently updated and inspected; this is why branch state has rows rather than one growing shared JSON object.

A branch arriving at its paired merge records arrival but does not execute the merge itself. Once all expected branches arrive, claim the group and schedule exactly one merge occurrence. That occurrence resumes the split's enclosing branch context. A second loop visit creates another split occurrence/group, so earlier arrivals cannot satisfy it. Overlapping/crossing parallel regions remain outside scope.

## Executor-dependent physical storage

`parallel_groups` and `parallel_branches` are the explicit database-runtime design. Their logical information is required, but custom coordination tables are conditional: a durable executor may own the fork/join state instead. If so, retain stable group/branch identities and read-only history sufficient for diagnosis, and either project these rows idempotently or omit them with an equivalent query adapter. Never schedule merges independently from both database rows and executor state. Decide this ownership before implementing their migrations; removing these tables requires updating `step_executions.branch_id` to the selected executor-reference contract and updating the diagrams.

`attempt_token` and bounded `attempt_history` describe the database-owned retry option. With an executor-owned retry history, persist only the references and diagnostics required by the app, while enforcing the same budgets and stale-result rules. Recorded retry attempts do not count as new node visits.

## Budgets, failures, and retries

Confirmed behavior: fixed server-enforced execution and active-time limits, copied onto every run. Human waiting does not consume active execution allowance. Recommended provisional values are **100 scheduled step attempts and 900 seconds of active execution per run**; these are engineering starting points, not measured requirements. Calibrate them against supplied shipments before the demo. They do not cap the separate 20–60 minute code-generation stage.

Count scheduling attempts, including bounded transient retries, before invocation so worker crashes cannot evade the limit. Recommended transient retry default: at most two retries for a classified transient error on the same fixed input. Use backoff and bounded tool-call timeouts; do not automatically retry a business-invalid invoice or treat every parser failure as transient. Attempt metadata is a small bounded collection; larger logs go to trace artifacts.

Active time is elapsed wall time while automated work is runnable/executing, including model/network waits and backoff; it is not the sum of parallel branch durations. Pause this clock only when the run is quiescent awaiting human input. If a sibling is still doing automatic work, the run remains active. Persist elapsed time at transitions and enforce deadlines outside generated code, including during a hung call. Queued capacity wait before starting is excluded.

On a required branch's execution failure, stop scheduling new downstream work in that run, let already-running independent work finish within the budgets, preserve its results, and stop before the incomplete merge. Cancel pending human requests that can no longer lead to completion. Explicit cancellation and exhausted global limits take precedence over allowing sibling work to finish.

An engineer's Retry creates a new run with the same code and sealed bundle, linked through `rerun_of_id`. The failed run is unchanged. Do not copy its human approvals. General user-directed resume-from-failed-step is future scope. Infrastructure recovery may redeliver pending durable work, but must check scheduling keys/tokens and never blindly replay completed side effects. Actual email delivery is excluded; reports are captured previews.

## Job integration and indexes

Rename the shared operation table to `workflow_jobs` and update every `job_id` reference. Add `input_bundle_id uuid?` for execution requests; initial Gmail ingestion can be the execution job's input-preparation phase before a run exists. Preserve the selected source request in validated job input metadata. Input preparation failure is recorded on the job even if no workflow run was created.

Include waiting_for_human in the active-operation uniqueness condition. Do not expire a legitimately waiting human job because no worker holds a lease. Resuming a response reacquires work with fresh fencing; do not keep a process or database transaction alive while the customer is away. The run record is the source of execution progress, while the enclosing job owns dispatch/cancellation. Root execution jobs can wait; scripted evaluation cases should not.

Useful indexes: runs by workflow/time and job, step occurrences by run/number and run/status, pending human requests by workflow/status, groups by run, branches by group, and artifacts by workflow/creation time. Unique scheduling/request keys provide idempotency. Verify same-run integrity for step, branch, group, request, and evaluation-result links at the database/mutation boundary. Store historical node identity from the frozen spec; never read a current draft's instructions to resume an old run.

Do not add a table per loop iteration type, a table per file format, a second job system for runtime, or a global reusable approval cache. Preserve the distinction between independently changing runtime rows and immutable aggregate manifests.

## Confirmed in this round

- Fixed demo limits, recorded per run; human waiting excluded from active time.
- Human text/decision responses only; changed documents require new input bundles and runs.
- Already-running independent parallel work may finish after a sibling failure, but the incomplete merge does not run.
- Retry starts a fresh run from the beginning with the same code/input bundle and a link to the failed run.

The exact numeric budgets, shared job-slot extension to manual runs, retry classification, and storage/worker implementation are recommended defaults. No live performance, database, or runtime verification has occurred.
