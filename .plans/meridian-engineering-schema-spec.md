# Meridian implementation, evaluation, and repair schema

October 7, 2026. Design proposal; no migration has been executed. Extends the [canvas](meridian-canvas-schema-spec.md) and [review](meridian-review-schema-spec.md) schemas.

## Recommendation

Version approved plans, generated code, and verified test suites independently. An evaluation binds exact code and suite versions; a repair session binds one plan and suite while advancing its accepted code baseline. A background operation owns the work, including failures before any code exists.

Below, IDs are UUIDs and times are `timestamptz`. Every table has an `id` primary key and `workflow_id`; workflow-owned references use composite foreign keys where needed to prevent cross-workflow links. Fields marked `?` are nullable. Add `created_at` to all records and `updated_at` to mutable records. Lifecycle transitions and cross-record consistency use controlled transactions, not unrestricted client writes.

## Plans and code

### `implementation_plan_versions`

- `frozen_spec_id uuid`, `version_number integer`, `parent_plan_version_id uuid?`
- `state text`: draft or approved
- `revision bigint`, `approved_at timestamptz?`

Unique `(workflow_id, version_number)`. Each new method choice after approval creates a new draft plan version. Recommended behavior: copy choices for convenience, but record approvals for the new version explicitly rather than copying timestamps that imply a new review occurred. A bulk approve action may approve its steps together. Approved plans and their step choices are immutable. Human steps mandated by the frozen workflow cannot be removed or converted to automatic execution.

### `implementation_plan_steps`

- `plan_version_id uuid`, `node_id uuid`
- `recommended_method text?`, `recommendation_reason text?`
- `selected_method text`: code, agent, or human
- `approved_at timestamptz?`, `revision bigint`

Unique `(plan_version_id, node_id)`. Validate node membership against the plan's frozen specification; a live node record supplies identity, not the authoritative execution definition. Store steps separately because methods and approvals are edited independently. Method edits in a draft clear that step's approval. Plan approval requires complete coverage of the executable frozen nodes and approval of every choice. Changes across steps and final approval are checked under the plan/workflow lock.

### `implementation_versions`

- `plan_version_id uuid`, `version_number integer`, `parent_version_id uuid?`
- `created_by_job_id uuid`, `artifact_id uuid`
- `entrypoint text`, `node_file_map jsonb`

Unique `(workflow_id, version_number)`. Create a version only after its complete project artifact is durably stored and its manifest validated. The artifact may contain code that subsequently fails compilation or tests; existence is not evidence of correctness. Preserve the dependency lockfile and runtime manifest with the code. A version is immutable; “passed” is derived from evaluations against particular suites, not a permanent boolean on the code record.

`parent_version_id` identifies the code actually used as the starting point, not simply the previous version number. A method-changing generation may use older-plan code as a seed; repair candidates must stay within the session's approved plan. Retain regressing candidates for inspection.

Read the project content hash from its immutable artifact record. Do not maintain another independently stored copy on the version. A distinct build-manifest hash would require a defined hashing contract and a demonstrated consumer; neither is currently needed.

## Trusted evaluations

### `evaluation_suite_versions`

- `frozen_spec_id uuid`, `version_number integer`, `parent_suite_version_id uuid?`
- `state text`: draft or locked
- `revision bigint`, `verified_at timestamptz?`, `locked_at timestamptz?`
- `evaluator_artifact_id uuid?`: optional while drafting, required and ready before locking

Unique `(workflow_id, version_number)`. Verification and locking preserve the cases, fixtures, expected values, and checking implementation together. Amendments create another version. Meridian's supplied expected results remain authoritative; implementation-specific tests may need a newly verified suite after a method change. The repair agent cannot edit locked tests, their input artifacts, or the trusted evaluator.

Read the evaluator hash from the immutable artifact. Locking requires a ready evaluator and ready fixtures, at least one required case with complete expectations/checks, and independent verification. Any subsequent draft edit to evaluator, inputs, cases, or expectations invalidates prior verification; verification must cover the exact suite revision being locked. Verify under the suite lock with an expected revision, and clear `verified_at` on every later content mutation. This lets `verified_at` refer to the current revision without another independently maintained verification-version field.

### `evaluation_cases`

- `suite_version_id uuid`, `case_key text`, `name text`
- `kind text`: unit, integration, extraction, or workflow
- `input_artifact_id uuid?`, `input_data jsonb`, `expected_output jsonb`
- `input_bundle_id uuid?`: required for workflow cases; references the immutable same-workflow bundle used by the runtime
- `check_manifest jsonb`
- `revision bigint`: positive per-case stale-edit version

Unique `(suite_version_id, case_key)`. `case_key` is stable across suite revisions when the case represents the same scenario. The manifest declares independently identifiable assertions and how the trusted evaluator checks them; assertion keys must be unique within a case. Large PDFs/fixtures use immutable artifact references; small parameters and scripted human responses can live in `input_data`. Expected structured results are distinct from email presentation wording. Business expectations must not be inferred from whichever output the candidate happens to produce.

Cases are owned by a suite version and immutable after locking. No shared cross-workflow test library or mutable global case definition is needed. Snapshotting cases into a new suite version is intentional historical duplication.

Case mutations lock the parent suite, require draft state, check the case revision, and advance both case and suite revisions. They invalidate previous suite verification. Case creation/deletion also advances the suite revision. Locking checks the expected suite revision under the same lock. These rules prevent a concurrent case edit from slipping into a verified suite and prevent one editor silently overwriting another's case.

### `evaluation_runs`

- `job_id uuid`, `implementation_version_id uuid`, `suite_version_id uuid`
- `status text`: queued, running, completed, blocked, or cancelled
- `verdict text?`: passed, failed, or inconclusive
- `failure_category text?`, `failure_code text?`, `failure_message text?`
- `started_at timestamptz?`, `finished_at timestamptz?`

All public evaluation runs cover the full locked suite. Repeated evaluation of the same versions creates a new run. Build/setup failures block the run and explain why cases did not execute. Completed means the scheduled cases have been accounted for, not that tests passed.

Recommended aggregate rules: passed requires every required case/assertion to pass; failed means complete, determinate checking with at least one failed assertion; missing results, execution errors, shared blockers, or cancellation make the verdict inconclusive. Keep known failures visible even when the aggregate is inconclusive. Never present an incomplete suite as passing.

### `evaluation_case_results`

- `evaluation_run_id uuid`, `case_id uuid`
- `status text`: queued, running, or finished
- `outcome text?`: passed, failed, error, or not_run
- `actual_output jsonb?`, `check_results jsonb`, `trace_artifact_id uuid?`
- `failure_category text?`, `failure_code text?`, `failure_message text?`
- `started_at timestamptz?`, `finished_at timestamptz?`

Unique `(evaluation_run_id, case_id)`. Validate that the case belongs to the run's suite. Initialize expected case-result records when the evaluation starts so missing/unrun cases cannot disappear from totals. A shared blocker marks remaining cases not_run with a reason. Independent cases continue after an individual assertion failure or processing error.

Store assertion-key outcomes in `check_results`; read expected values from the immutable case. An exact total pass count is insufficient for comparing regression sets. Unit checks do not need workflow/step execution records; workflow cases link to execution history in the next schema portion. Larger raw outputs belong in artifacts, not unbounded JSON logs.

Failure category describes the cause separately from outcome: implementation, input, infrastructure, or unknown. A generated-code compile error is repairable implementation failure. Expired access credentials require access recovery. A PDF-processing error requires diagnosis rather than automatically assuming either category. A timeout alone does not establish its root cause.

## Jobs and repairs

### `workflow_jobs`

- `kind text`: generation, evaluation, repair, or execution
- `status text`: queued, running, waiting_for_human, cancel_requested, succeeded, failed, or cancelled
- `request_key text`, `phase text`, `progress jsonb`
- `plan_version_id uuid?`, `input_version_id uuid?`, `suite_version_id uuid?`
- `input_bundle_id uuid?`, `source_request jsonb?` for manual execution/input preparation, as defined in the runtime schema
- `executor_ref text?`
- `lease_token uuid?`, `lease_expires_at timestamptz?`: conditional fields for a database-owned worker lease; omit if the chosen executor owns claims and recovery
- `error_code text?`, `error_message text?`
- `started_at timestamptz?`, `finished_at timestamptz?`

Unique `(workflow_id, request_key)` makes repeated submissions return the same operation; reject reuse with different inputs. A unique partial index on `workflow_id` for queued/running/waiting_for_human/cancel_requested enforces one active operation per workflow. Inspection remains available, and different workflows can execute independently. This table supersedes the earlier name `engineering_jobs`; it is one shared operation mechanism. Extending the slot to manual execution is a recommended demo simplification from the runtime pass.

Generation requires an approved plan; an optional input version is its seed. Evaluation/repair require an input code version and locked suite; their plan is determined by that version. Validate ownership and frozen-spec compatibility. Inputs remain pinned even if an engineer prepares another plan/suite while work runs. A new version does not redirect an active job.

Manual execution requires an input code version and either a sealed input bundle or a validated source-capture request. Resolve the latter to a sealed bundle before creating the run. A retry references its original code and bundle, not the workflow's latest version.

Only top-level operations receive this exclusivity slot. A repair's generation and evaluations are child records of that operation, not competing jobs. Recommended launch default: first evaluation runs inside the generation job when a locked suite is selected; repair requires the engineer's explicit action. Without a locked suite, show that generated code has not been evaluated. Automatic first evaluation remains a recommended implementation default.

`phase` and completed/total counts support honest progress; do not invent an overall percentage. A successful job may contain failing tests: job status describes orchestration, not correctness. Worker details are not a commitment to a particular queue or hosting vendor.

### `repair_sessions`

- `job_id uuid`, `plan_version_id uuid`, `suite_version_id uuid`
- `initial_version_id uuid`, `baseline_version_id uuid`, `baseline_evaluation_id uuid`
- `attempt_limit integer DEFAULT 3`
- `status text`: running, passed, needs_attention, failed, or cancelled
- `stop_reason text?`, `finished_at timestamptz?`

Unique `job_id`. Pin plan and suite for the whole session. The baseline evaluation must refer to the baseline code and fixed suite. If the suite changed, reevaluate before starting a new session. An implementation error in a baseline can still be a repair target; infrastructure failure does not justify speculative business-code edits.

The baseline evaluation pointer records the evidence used for decisions. Preserve starting version identity even after advancing the baseline. A new explicit session receives a fresh limit; infrastructure retries inside a stage must be bounded and cannot silently create unlimited repair attempts.

### `repair_attempts`

- `session_id uuid`, `attempt_number integer`, `baseline_version_id uuid`
- `baseline_evaluation_id uuid`, `diagnosis jsonb`
- `candidate_version_id uuid?`, `evaluation_run_id uuid?`
- `status text`: running, accepted, rejected, failed, or cancelled
- `decision_reason text?`, `error_code text?`, `error_message text?`
- `started_at timestamptz`, `finished_at timestamptz?`

Unique `(session_id, attempt_number)`, unique nonnull `candidate_version_id`, and at most one running attempt per session. Create the attempt before invoking generation so failures without a code artifact remain visible. A candidate, when present, is generated from this recorded baseline and approved plan. An attached evaluation must test that candidate on the session's suite.

The trusted evaluator, not the repair agent, determines acceptance. A candidate can advance the baseline only after a full, determinate suite evaluation and preservation of every previously passing assertion on that same suite. Equal pass sets can still be non-regressing; the three-attempt budget bounds lack of progress. Partial checks, missing results, and errors cannot establish acceptance. All assertions passing ends the session. Otherwise accepted non-regressing work may become the next baseline; rejected candidates stay in history while the prior baseline remains selected.

Targeted internal checks are diagnostic artifacts and are never represented as a full-suite pass. An attempt that fails compilation remains recorded and consumes its attempt. A need to change the approved method, frozen process, or expected labels ends autonomous repair for engineer attention. Method changes produce a newly approved plan; no post-handoff business-process revision is supported by the demo.

## Constraints, access, and transactions

Executor ownership must be chosen before migrations: either the database owns work claims/leases or a durable executor does. `workflow_jobs` remains the application's durable request/cancellation/idempotency record in either case. Do not create competing lease/retry authorities; translate executor callbacks through idempotent, state-checked mutations. The lease protocol below describes the database-owned option. Regardless of executor, cancelled or obsolete work cannot publish authoritative outputs.

- Approved plan children, locked suite children, code artifacts, and finished evaluation results are immutable. Implement these protections at the database/write boundary, not only through disabled UI controls.
- Use indexes for plan-step lookup by plan, suite-case lookup by suite, code history by workflow/version, evaluation history by workflow/time and code/suite, case results by evaluation, and attempts by session/number. Existing unique constraints cover several of these patterns; avoid redundant indexes. No JSON search indexes are justified by the current read paths.
- Start a job under a short workflow lock: validate frozen state and inputs, enforce idempotency/exclusivity, create operation records, and arrange reliable dispatch. Queue publication must recover from a crash after database commit; use a transactional outbox or an equivalent durable executor mechanism when choosing infrastructure.
- Claim/renew work with a lease and fencing token. Before publishing outputs or changing the baseline, verify job state and current token. The exclusive row alone does not prevent duplicate workers from executing the same job.
- Accept/reject an attempt under the session/workflow lock, storing the decision and baseline changes atomically. Preserve the evaluation used for that decision. Do not hold database transactions open during generation or test execution.
- Cancellation keeps the active slot while stopping work. Preserve completed artifacts/results, record interrupted stages, and prevent late workers from promoting candidates. Release the slot only after cancellation is acknowledged or work has been safely fenced and cleanup arranged. An explicit new operation never silently resumes a cancelled session.
- The evaluator and test assets must be outside the candidate's write authority. Test changes are explicit engineer actions that create new verified suite versions; generated code cannot write its own acceptance results.

## Confirmed in this round

- Explicit approved-plan revisions preserve previous plans, code, and evaluations.
- Continue independent evaluation cases; distinguish failed assertions, execution errors, and shared blockers.
- One active engineering operation per workflow; existing artifacts remain inspectable.
- Full-suite runs in the demo UI; internal targeted checks do not establish overall acceptance.

The [runtime schema](meridian-runtime-schema-spec.md) completes workflow executions, step occurrences, human requests, input/artifact ownership, and loop limits. The proposed worker lifecycle and evaluator rules above are engineering recommendations; no infrastructure has been provisioned or live schema tested.
