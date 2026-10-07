# Meridian entity model

Step 2 checkpoint — October 7, 2026. Builds on [business requirements](meridian-business-requirements-spec.md). This is the recommended entity model; column definitions, constraints, and the final physical table layout come next.

## Recommendation

Use relational records for independently edited or tracked objects, immutable snapshots for frozen definitions and versioned evaluation material, and artifact references for larger files. Separate workflow definitions from executions. Do not create a separate table for each primitive type or put execution history inside canvas nodes.

The main boundary is independent identity and lifecycle, rather than whether something is a noun. Owned collections may remain inside an aggregate if they are always read and versioned together; the next pass will decide their physical representation.

## Candidate entities

| Entity / candidate table | Purpose and reason for separation |
| --- | --- |
| Workflow — `workflows` | Named workspace, customer-stated desired outcome, lifecycle state, and entry point for listing and reopening saved work. |
| Node — `nodes` | One editable primitive with stable identity, type, definition, and canvas placement. All primitive types share this entity. |
| Connection — `connections` | A separately editable route between nodes, including its condition. Avoid duplicating predecessor/successor lists in node records. |
| Frozen specification — `frozen_specs` | Immutable complete graph captured at handoff, with schema format/version information. Generation reads this snapshot. |
| Review run — `review_runs` | One requested AI review: reviewed input, model, progress, cancellation, and completion. One review may produce or revisit multiple findings. |
| Discussion thread / finding — `discussion_threads` | Shared container for customer notes, AI findings, and review clarification. Findings carry category (including simplification), disposition, proposed detail edit, and prior-finding reference. Only open findings block freeze. This supersedes the initial separate `findings` candidate. |
| Discussion message — `discussion_messages` | Clarification questions, answers, and finding discussion. Replies can reference parent messages. Preserve which review produced an AI message. Exact thread ownership constraints come next. |
| Thread anchor — `thread_anchors` | Links a finding or customer note to graph elements without duplicating its conversation. Explicit workflow/element scope prevents a deleted target from accidentally becoming a workflow-wide comment. |
| Implementation plan version — `implementation_plan_versions` | Versioned engineer-approved methods associated with a frozen spec. Independently edited/approved choices use child `implementation_plan_steps` records. Approved versions remain immutable. |
| Implementation version — `implementation_versions` | Immutable generated project, artifact reference, and parent code version. This is a whole-project version; a repair can change just one file without inventing independently versioned step packages. |
| Evaluation suite version — `evaluation_suite_versions` | Immutable verified cases, inputs, expectations, and checking rules. Cases use owned `evaluation_cases` records; no shared cross-workflow test library is needed. |
| Evaluation run — `evaluation_runs` | One evaluation of an exact implementation version against an exact suite version, with status and summary. |
| Case result — `evaluation_case_results` | Expected-versus-actual outcome and diagnostics for one case within an evaluation. Separate from the aggregate so cases can complete and be inspected independently. |
| Repair session — `repair_sessions` | Fixed suite, starting/current baseline, attempt budget, and stopping reason. Latest generated code and current accepted baseline are different concepts. |
| Repair attempt — `repair_attempts` | One attempt's baseline, diagnosis, generated candidate, evaluation, and acceptance decision. Needed even if generation fails before producing a candidate. |
| Background operation — `workflow_jobs` | Shared durable generation/evaluation/repair/execution operation, with input references, progress, idempotency, cancellation, and one-active-operation-per-workflow enforcement. Supersedes the earlier `engineering_jobs` name. |
| Workflow run — `workflow_runs` | One execution on concrete inputs, whether a manually selected shipment or a workflow-level evaluation case. Unit tests need not create workflow runs. |
| Step occurrence — `step_executions` | One visit to a frozen node during a run, with input, output, state, and errors. Loops and parallel branches require occurrence identity beyond node identity. |
| Human request — `human_requests` | Pending question/approval and its response, belonging to a particular step occurrence. This has its own waiting/resumed lifecycle. It may be an owned one-to-one record if that simplifies the final schema. |
| Artifact — `artifacts` | Metadata and durable storage reference for source documents, generated projects, or larger traces. Preserve exact input/code identity without putting large file bytes into frequently updated records. |
| Input bundle — `input_bundles` | Immutable manifest of captured email/document inputs, reused by exact-input reruns and evaluation cases. |
| Parallel group and branches — `parallel_groups`, `parallel_branches` | One split occurrence and its expected branches; joins cannot reuse arrivals from another loop iteration. |

These are a concrete starting model, not a demand for an independently exposed API or subsystem per entity. Child collections and one-to-one data can be combined where their access and lifecycle justify it. The later schema proposals refine their physical representation. Do not collapse independently changing records merely to minimize table count.

## Decisions established in this interview

**Repair baselines.** Retain failed/regressing candidates and their results, but continue from the last non-regressing baseline. Compare individual checks on the same fixed suite, not only pass counts. A candidate that breaks a previously passing check does not become the baseline. A candidate may descend from an older version; version lineage is not necessarily a simple chronological chain. A failed evaluation caused by infrastructure provides no evidence that a candidate improved correctness.

**Suite revisions.** Engineers may explicitly correct tests by creating a newly verified suite version. Preserve earlier suites and evaluation results. End an active repair session before switching suites; reevaluate the selected baseline against the new suite before starting another session. The repair agent cannot revise expectations.

**Competing edits.** Reject stale saves and preserve the browser's unsaved text for recovery. Recommended mechanism: per-record revision checks for nodes and connections. Also enforce workflow editability atomically so a stale tab cannot write during review or after freeze. The exact transaction protocol is a later design task.

**Deleted targets.** Automatically close an open finding if its only referenced block is deleted, recording a distinct target-deleted closure reason. Do not rewrite an already-closed decision. Findings with other targets remain open. Preserve the deleted block's identity and context for historical inspection. Recommended implementation: logical deletion of nodes and incident connections; live graph queries and freeze exclude them. Handling findings anchored only to removed connections should follow an explicit rule during the constraints pass rather than silently treating them as workflow-wide findings.

**Human responses.** Require a fresh response on every visit to a human step. Attach the response to the run's specific step occurrence, never to the reusable canvas node. Approval reuse is outside scope. Evaluations may provide scripted responses as fixed test inputs, clearly distinguished from real human decisions.

## Operations that validate the boundaries

- **Edit a block:** update its record only if the revision matches and its workflow is editable. Unrelated blocks should not conflict just because they share a workflow.
- **Freeze:** validate and capture one consistent graph, then lock editing. The frozen snapshot and workflow state change must succeed together.
- **Delete a block:** remove it and incident routes from the active graph and close eligible findings in one consistent operation, retaining history.
- **Repair:** read a fixed baseline and suite, create an attempt and candidate, evaluate, then either advance the baseline or retain the rejection. Preserve the attempt even if a stage fails.
- **Resume a human step:** accept one response for a specific pending request and resume that occurrence once. A later loop visit creates another occurrence and request.

## Scale and next step

Node rows are not inherently an explosion: ten thousand workflows with fifty nodes each produce five hundred thousand node rows. That is a sizing example, not a throughput claim. The likely faster-growing data is repeated runs, step traces, and test results; size and retention must be estimated separately.

Next define fields, keys, constraints, and access patterns. Start with workflows, nodes, connections, and frozen specs; then review data; then execution/evaluation history. Choose indexes from the queries and transaction boundaries from the operations above. No sharding, graph database, event-sourced editing system, or real-time collaboration infrastructure is justified yet.
