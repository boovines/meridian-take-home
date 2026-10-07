# Feature: Self-Healing Agent

Owner: Justin Hou · Updated October 7, 2026

Revised from the original [Self-Healing Agent PRD](https://docs.google.com/document/d/1ARjmPNDBDeczJDOFiMdOHB7r4_Z6-9CQCb2Mm7PHjiA/edit?tab=t.pu7htoe08d7v) and the requirements/schema interview. This local revision supersedes the original's conflicting scope; the Google Docs tab has not been updated because it is view-only in the current account.

## Motivation

### Problem: Self-healing

A frozen process is not yet a working implementation. Engineers need to choose which steps use code, agents, or humans, inspect the generated project, and verify behavior against trusted expectations. This feature repairs implementation failures within an approved plan while preserving the process, tests, and history. It must distinguish execution success, business outcomes, and evaluation correctness.

### Example workflow: Pre-arrival document review

An engineer selects agent-based document extraction, code for deterministic checks and deduplicated totals, and human handling where the customer requires it. A selected Gmail shipment is captured with its email bodies and attachments, then processed into invoice, good, and batch results and an email report preview. No email is sent.

One regression case checks that two missing fields on one good produce one failed good and two details. Other cases cover complete packets, duplicate invoices, and missing or mismatched CoAs. A wrong total establishes a failed assertion; step traces and targeted checks help diagnose the cause rather than assuming the total identifies the faulty step.

## Requirements/Acceptance Criteria

Generation requires a frozen spec and an engineer-approved implementation plan. AI proposes Code, Agent, or Human with a reason; the engineer approves the choices. Customer-required human approvals remain fixed. Method changes create a new approved plan and code version, preserving earlier results. A needed business-process change is a blocker because post-handoff whiteboard revision is outside demo scope.

Generate an inspectable, downloadable project whose files map to frozen steps. The app evaluates its own immutable code versions. Read-only code and diff views replace an in-browser IDE; repository connection and importing IDE edits are deferred.

Evaluations bind an exact code version to a locked suite of inputs, expected outputs, and grading rules. Meridian's supplied ground truth is authoritative for the demo. Exclude mismatched-invoice scoring without excluding batch/CoA checks. Add independently verified unit, integration, or extraction checks where useful; broad OCR benchmarking is deferred. A generated test is not trusted merely because the generated code passes it.

Run the full suite from the UI. Continue independent cases after assertion failures or execution errors; a shared build/prerequisite failure blocks the evaluation. Show failed assertions, execution errors, and shared blockers separately. Partial, cancelled, or indeterminate evaluations cannot establish overall success. Infrastructure failures such as expired access require operational attention, not speculative business-logic repairs.

The engineer explicitly starts Repair and rerun. Each session allows three attempts and uses the same approved methods, frozen process, and trusted suite. Every attempt retains its diagnosis, code change, and results. Promote a candidate only after full, determinate evaluation preserves every previously passing assertion on that suite. Reject regressions and continue from the last non-regressing baseline, even if the latest candidate fixed something else. Targeted checks are diagnostic, not acceptance evidence.

Stop when all checks pass, the budget is exhausted, or progress needs a method, process, or expectation change. Show Needs engineer attention with remaining failures and attempted changes; the engineer can start another session. Correcting expectations requires a new explicitly verified suite version, preserves previous results, ends the old repair session, and reevaluates the selected baseline before another session. The repair agent cannot edit trusted tests or its own grades.

## Product Experience

Implementation, Agent, and Evaluation remain three tabs in the same workspace, labeled with the frozen spec. Implementation lists each step, suggested method, rationale, and approval. Generation is disabled until all required choices are approved. Revised plans preserve previous choices and evidence as separate versions.

Agent shows the selected version, file tree, source preview, changes from its parent, and Download. Background work shows its actual stage, completed work, useful errors, and Cancel. Existing code and results stay readable. Only one generation, evaluation, or repair operation runs per workflow; a repair's internal evaluations belong to that operation. Operations survive closing the browser.

Evaluation shows the code and suite versions together, per-case results, and expected versus actual output. Selecting a failure exposes step inputs, outputs, errors, and any proposed diagnosis. History distinguishes the latest attempt from the current repair baseline. Recommended launch default: generation starts the first evaluation when a locked suite is selected; otherwise show Generated—not yet evaluated. Repair always requires an explicit action.

A manual run starts from an existing shipment email or shipment number. A human step pauses for text or approval/rejection in the app, then resumes. Each visit requires a new response, including loop revisits. Changed documents start a new bundle and run; uploads into a paused run are deferred. Automated evaluations use explicit fixture responses; missing responses are test execution errors, not indefinite human waits.

Fixed server-side step and active-time limits stop unbounded runs as Needs attention and preserve their trace; human waiting does not consume active time. A crashed parallel branch prevents the required merge; already-running independent work may finish within limits for diagnosis. Retry starts from the beginning with the same code and inputs, links to the failed run, and requires fresh human responses. General failed-step resume is deferred.

## Tech Stack

React/TypeScript and Next.js serve the web app and API; Supabase/Postgres stores durable metadata and object storage holds code, fixtures, source documents, and large traces. Gmail uses a scoped Composio integration adapter. An OpenAI-backed coding worker generates and repairs projects.

A durable background executor handles generation, evaluation, repair, and runs. Temporal is required by the assignment and is the selected durable executor for dispatch, cancellation, and recovery. Vercel may host the web app, while long-running work needs a separately validated execution arrangement. Generated code runs in Vercel Sandbox with denied network egress and no application credentials. A trusted runtime enforces routing, human gates, and limits; trusted grading and fixtures remain outside generated code's write authority.

## Data Model

`implementation_plan_versions` and `implementation_plan_steps` capture choices against a frozen spec. `implementation_versions` records immutable generated projects, their parent, plan, and artifact. `evaluation_suite_versions` and `evaluation_cases` store versioned trusted expectations and fixed inputs. Approved plans and locked suites cannot be edited in place.

`evaluation_runs` and `evaluation_case_results` bind code, suite, coverage, and results. `workflow_jobs` handles operation identity, status, progress, idempotency, and worker ownership. `repair_sessions` pins the plan and suite while tracking its accepted baseline; `repair_attempts` preserves each candidate and the evidence for accepting or rejecting it. Job completion does not mean tests passed.

`artifacts` identifies immutable stored files; `input_bundles` seals a manifest of source messages and attachments so retries use identical inputs. `workflow_runs` stores code, bundle, limits, outcome, and retry ancestry. `step_executions` records each visit separately from the canvas node. `human_requests` belongs to one visit. Temporal associates arrivals with a particular split occurrence, preventing a prior loop iteration from satisfying a new join; separate SQL parallel-coordination tables are omitted.

Ownership constraints, indexed parent lookups, idempotent scheduling, and short atomic mutations protect history and prevent duplicate work. Large bytes stay outside rows. Separate records are justified by independent lifecycles; immutable manifests and bounded per-step attempt details can remain JSON. Project/evaluator hashes come from their immutable artifacts. Case edits use revision checks and invalidate suite verification. Per-node visit numbers address human-response fixtures independently of parallel scheduling order. Detailed fields, constraints, and indexes live in the [engineering schema](../.plans/meridian-engineering-schema-spec.md) and [runtime schema](../.plans/meridian-runtime-schema-spec.md).

The [data-model decision audit](data-model-decisions.md) justifies each table and the alternatives. Explicit parallel coordination tables and custom worker leases are conditional on executor ownership; their logical guarantees remain required, but the app must not build a competing scheduler alongside a durable executor.

## API Endpoints

Proposed API contracts, not implemented routes. Background operations return a durable job ID; duplicate request keys return the original operation, and conflicting key reuse is rejected.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/specs/:id/implementation-plans` | Propose a plan or create a revision from an existing plan. |
| `PATCH /api/implementation-plans/:id/steps/:stepId`; `POST /api/implementation-plans/:id/approve` | Edit/approve methods and seal the plan. |
| `POST /api/implementation-plans/:id/generations` | Generate a code version; optionally select a locked suite for first evaluation. |
| `GET /api/workflows/:id/versions`; `GET /api/implementation-versions/:id` or `/:id/download` | Inspect code, parent diff, and downloadable artifact. |
| `POST /api/specs/:id/evaluation-suites`; `PATCH /api/evaluation-suites/:id` | Create/revise and edit a draft suite and its cases. |
| `POST /api/evaluation-suites/:id/lock` | Record independent verification and seal the expectations. |
| `POST /api/workflows/:id/evaluations`; `GET /api/evaluations/:id` | Run the full selected code/suite pairing or inspect results. |
| `POST /api/workflows/:id/repairs`; `GET /api/repair-sessions/:id` | Start a bounded session or inspect attempts and baseline. |
| `GET /api/jobs/:id`; `POST /api/jobs/:id/cancel` | Inspect or cancel durable work. |
| `POST /api/workflows/:id/runs`; `GET /api/runs/:id` | Capture selected Gmail inputs and execute, or inspect trace/report. |
| `POST /api/runs/:id/retry`; `POST /api/human-requests/:id/respond` | Start a linked fresh run or atomically record one human response and continuation. |

The [architecture](architecture.md) and [verification plan](verification.md) define shared behavior and failure checks. Numeric limits, executor choice, and extending operation exclusivity to paused manual runs are recommended defaults to validate during implementation, not additional confirmed requirements. Deferred work remains in the [README](../README.md#future-work-outside-demo-scope).

## Current implementation checkpoint

The [generation](engineer-generation.md), [runtime](workflow-runtime.md), and [evaluation](trusted-evaluations.md) guides describe implemented behavior and routes. The evaluation screen supports full-workflow and JSON-output step checks, explicit verification, sealed suite revisions, full-suite execution, comparison details and visit traces. Arbitrary unit-test code and broad OCR benchmarks remain deferred. Evaluation currently starts explicitly; automatic evaluation of a selected suite after generation and the bounded repair loop are still pending. These limits do not change the acceptance target above.

### Bounded repair implementation checkpoint

Repair is now implemented with a three-attempt limit and a recorded two-hour session deadline. Every candidate uses the same approved plan and locked suite; regression checks compare assertion identities. Candidate history and the retained baseline are distinct. The Evaluation tab includes a baseline sidebar, attempt diagnoses, acceptance reasons and links to code/evaluations. The executable schema is migration 009 and the implemented contract is in `specs/bounded-repair.md`. Live synthetic repair passed; Gmail/PDF ground-truth verification remains pending.
