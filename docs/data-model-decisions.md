# Data model decisions and justification

Audit date: October 7, 2026. Scope: the agreed take-home features, with growth considered but no claimed production capacity. This document explains the proposed tables, important field groups, relationships, and alternatives. Exact field inventories remain in the linked schema specifications. No migration or load test has been run.

## Audit conclusion

The main domain boundaries are justified by concrete operations. The previous proposal nevertheless overstated how settled the physical runtime design was and had several field-level gaps. This audit makes the following changes:

| Decision reconsidered | Revised decision | Reason |
| --- | --- | --- |
| Project/evaluator hashes duplicated on version rows | Keep the authoritative byte hash on `artifacts`; versions reference that immutable record. | Independent copies add a consistency obligation without a demonstrated query benefit. |
| Evaluator required even on an empty draft suite | Allow null during drafting; require a ready evaluator before lock. | Creation should not require the finished evaluator. Locked suites still pin exact grading behavior. |
| Test cases had no stale-edit version | Add a case revision; serialize case edits and suite locking through the parent suite. | Otherwise two editors can overwrite a case or change expectations while the suite is being locked. |
| Verification was only a timestamp | Invalidate it on every draft suite/case/evaluator/input change; lock checks the verified suite revision. | A previous verification must not cover subsequent unverified edits. |
| Fixture responses addressed by an ambiguous visit number | Add a per-node visit number separately from the run-wide scheduling number. | Parallel execution order must not change which response a human step receives. |
| Model/settings sufficient to explain review behavior | Add `reviewer_version`, identifying the deployed prompt/application revision. | The same model can produce different review behavior with a changed prompt. This is provenance, not guaranteed reproducibility. |
| Custom leases and parallel coordination implicitly required | Make these physical choices conditional on executor ownership. | A durable executor and the database must not become competing scheduling authorities. |

The reference design still lists **25 application tables**. That is not a target count or a requirement to implement a custom engine. Twenty-three tables are the recommended application record boundaries; the two explicit parallel coordination tables depend on the executor decision. Some fields on jobs/steps also depend on that choice. Infrastructure may require its own tables. The runtime decision cannot honestly be called final before a small execution prototype.

## How a table earns its place

A separate table is warranted when records need independent identity, edits, lifecycle, querying, constraints, or retention. A domain noun alone is insufficient. An owned immutable collection consumed as a whole can remain JSON. Data recoverable cheaply and unambiguously from an authoritative record should usually not become a second editable copy.

The examples below distinguish a strong requirement from the chosen implementation. Alternatives can satisfy the same requirement; the reason for preferring this model is explicit in each case.

## Canvas: four tables

### 1. `workflows` — keep

One row is one named workspace the customer can list, reopen, review, and freeze. `name` and `desired_outcome` describe the process; `state` controls editability. The desired outcome cannot be derived reliably from an Outcome node because a process can have multiple terminal outcomes.

`revision` protects metadata edits; `content_revision` identifies semantic freshness across child edits; `active_review_run_id` identifies who currently holds the review lock. These have distinct roles. The pointer and state must change together. A workflow-wide giant document would make all node edits compete on one aggregate and weaken element-level constraints.

### 2. `nodes` — keep

One row is one independently editable primitive. Type, title, instructions, and position are common fields. `config` holds validated type-specific settings; a table for every primitive type is unnecessary while they share editing and lifecycle behavior. Canonical requirements live in `instructions`, not a second editable copy in config.

`split_mode` expresses the explicit routing choice. `join_for_split_id` pairs a merge with its split without inventing a separate merge primitive. `revision` rejects stale saves; `deleted_at` preserves references after deletion. A node array on the workflow is simpler to serialize, but poorly matches individual editing, anchoring, and endpoint constraints.

### 3. `connections` — keep

One row is one route with independently editable endpoints and condition. `is_default` expresses Otherwise without encoding it as a magic phrase in `condition_text`. Stable connection identity supports comments on a route and runtime diagnostics.

Same-workflow endpoint foreign keys prevent cross-board edges. One active default route per source is unique. Do not also persist predecessors/successors on nodes; derive adjacency from connections. An in-memory adjacency map can accelerate traversal after loading, but is not a replacement for storage integrity.

### 4. `frozen_specs` — keep

One row preserves the complete, immutable handoff: graph, desired outcome, format version, reviewed decision evidence, and acknowledgment of unreviewed changes. The unique workflow relationship encodes the demo's one-freeze rule.

The snapshot intentionally duplicates draft data at a business boundary. Merely setting `workflows.state = frozen` would couple historical generation to live child rows. Separate frozen node/edge tables would be warranted if we needed cross-version relational graph queries; the current consumers read the whole snapshot, so JSON is sufficient.

## Review: four tables

### 5. `review_runs` — keep

One row represents one requested review, including failure/cancellation before any finding exists. Status, phase, input identity, model/settings, and reviewer version explain what produced a result. Starting and analyzed snapshots differ when the customer confirms a missing goal during clarification.

Two snapshots cost storage, but they record a meaningful input change rather than every edit. A future optimization could share identical snapshots; it is unnecessary now. Storing only comments would lose unsuccessful reviews and whether the freeze minimum was met. Runtime dispatch may share infrastructure with jobs without conflating these product records.

### 6. `discussion_threads` — keep

One row is a finding, ordinary note, or clarification conversation. They share titles, replies, and anchors; `kind` selects the appropriate rules. Findings additionally need category, disposition, explanation, linked prior finding, and a proposed detail edit with the expected node revision.

Current closure fields make open-finding queries simple; historical decisions live in messages. Update both atomically. Separate note/finding conversation systems would duplicate their shared behavior; one undifferentiated comment type would lose the freeze distinction. Proposed edits belong to one finding and do not need a separate proposals table yet.

### 7. `discussion_messages` — keep

One row is an appended comment or system decision event. `parent_message_id` supports reply trees, while `message_number` defines stable thread order. `author_kind` distinguishes customer/AI/system; it does not claim authenticated user attribution. Review provenance explains a later follow-up in an older thread.

Messages grow independently of thread status. An array on the thread would rewrite a shared conversation value for each reply and complicate idempotency. Event payloads preserve closure/reopening/application history without adding an audit subsystem for every entity. This is selective history, not event sourcing the whole application.

### 8. `thread_anchors` — keep

One row links a thread to exactly one node or connection. Several rows allow one discussion to span multiple elements without copying messages. `context_snapshot` retains the referenced label/excerpt after edits or deletion.

Two nullable, mutually exclusive foreign keys are deliberate: the target types are few and known. A generic `target_type/target_id` pair would make ordinary foreign-key enforcement harder. Workflow-wide threads have explicit workflow scope and no anchors; they are not confused with threads whose targets were removed.

## Engineering and evaluation: ten tables

### 9. `implementation_plan_versions` — keep

One row is a draft or approved method plan for a frozen specification. Version number is for display; UUID is identity; the parent records provenance. Approval seals the plan. Changing Agent to Code creates a new version without rewriting what an old implementation was generated from.

Combining this with code versions would prevent representing an approved plan before generation succeeds or generating multiple projects from the same plan.

### 10. `implementation_plan_steps` — keep

One row is one node's recommended and selected method within a plan, with rationale, approval, and edit revision. Unique `(plan_version_id, node_id)` prevents conflicting duplicate choices.

Rows match the UI's per-step editing and approval. A single plan JSON object is possible, but introduces whole-plan edit conflicts and weaker uniqueness enforcement. Plan approval must validate complete executable-node coverage against the frozen snapshot; a node foreign key alone cannot establish membership in that version.

### 11. `implementation_versions` — keep, simplify

One row identifies a complete generated project, its approved plan, actual parent code version, creating job, artifact, entrypoint, and node/file mapping. The immutable artifact owns its hash; the redundant version hash has been removed.

A parent is necessary because a repair can continue from an older non-regressing baseline rather than the latest version. Files can remain an immutable archive/manifest because the app previews/downloads whole project versions and does not independently edit or version each file. Do not add a permanent pass flag; correctness depends on a suite and evaluation.

### 12. `evaluation_suite_versions` — keep, tighten locking

One row defines a draft or locked collection of trusted expectations and evaluator behavior. Version/parent references preserve corrections. Evaluator identity may be absent while drafting but must reference a ready immutable artifact at lock; its hash comes from that artifact.

Verification applies to the exact suite revision. Draft changes clear verification; lock checks the expected revision, requires at least one required case, and seals children too. Merely versioning expected totals while allowing the grader or inputs to change would not preserve the benchmark.

### 13. `evaluation_cases` — keep, add concurrency protection

One row is a named case owned by one suite version. `case_key` identifies the scenario across revisions; `kind` distinguishes unit/integration/extraction/workflow checks. Inputs, expected output, and the check manifest have separate roles. Workflow cases require a sealed bundle; small parameters and scripted responses can remain JSON.

Per-case revision rejects stale edits; every case mutation advances the parent suite revision and clears verification under its lock. Cloning cases on suite revision deliberately preserves history. A global mutable case library would add sharing/version complexity not required by the demo.

### 14. `evaluation_runs` — keep

One row is an execution of an exact code/suite pairing. `status` records orchestration; `verdict` summarizes grading. Completed can mean all scheduled cases were accounted for, including failed assertions. Errors and incomplete coverage remain inconclusive, with known failures still visible.

The verdict is a controlled summary of immutable case results, not an independently editable judgment. Computing it on read is a reasonable alternative at small scale; persisted final summaries simplify history and repair decisions if finalization validates the result set. A generic job alone cannot express the pairing or its correctness evidence.

### 15. `evaluation_case_results` — keep

One row stores a particular case's actual output, assertion results, trace, and failure category within an evaluation. Unique `(evaluation_run_id, case_id)` provides complete case accounting. Initialize expected case rows so unrun cases cannot disappear.

Independent cases finish at different times and are inspected individually. Rows avoid one growing evaluation-results blob. Assertion-level outcomes remain JSON because the UI consumes one case's checks together; cross-run assertion analytics could justify further normalization later. Read expected values from the locked case rather than duplicating them.

### 16. `workflow_jobs` — keep application identity; condition worker fields

One row captures an explicit expensive operation, including failures before a code version or workflow run exists. Kind, immutable input references, request key, status, progress, and cancellation give the UI a durable operation to follow. Different kinds can share a table because admission, cancellation, and progress behavior are common; kind-specific checks validate required inputs.

`executor_ref` links external execution. Custom leases/tokens are justified only if this database owns worker claims. If a durable executor owns recovery, use its identifiers and state-checked callbacks instead of a second lease system. Progress is a projection, never authority to pass tests or promote code. One active operation per workflow is a demo restriction, not a future throughput strategy.

### 17. `repair_sessions` — keep

One row owns a fixed plan/suite, initial version, current baseline and evaluation, three-attempt budget, and stopping reason. A new session is an explicit engineer action.

It differs from a job because it owns domain-specific acceptance state. The baseline pointer is intentionally stored for efficient, atomic decisions; it must correspond to recorded accepted evidence. Deriving it from “latest version” is incorrect. Combining these fields into job JSON would obscure typed version relationships and make invalid repair state easier to store.

### 18. `repair_attempts` — keep

One row records one attempt's starting baseline, diagnosis, optional candidate/evaluation, and acceptance decision. Create it before generation: an attempt can consume budget without producing code.

Unique session/attempt number and unique candidate identity preserve ordering and provenance. Neither code versions nor evaluations alone capture generation failures, rejected candidates, or why the baseline did not advance. Diagnosis is model-produced advice; the trusted result and acceptance rule determine promotion.

## Runtime and artifacts: seven reference tables

### 19. `artifacts` — keep

One row identifies stored bytes, ownership, kind, readiness, stable storage key, hash, size/type, and descriptive metadata. The actual PDF/project/trace lives in object storage. Pending/ready/failed separates incomplete upload from usable content; ready records are immutable.

One registry avoids copying file metadata into every consumer table. Hash is not a global primary key: identical bytes may belong to different workflows. Cross-workflow deduplication is not required. Expiring download URLs are generated on demand, not persisted as object identity.

### 20. `input_bundles` — keep

One row seals the exact captured messages, attachment associations, source identifiers, and shipment reference for a run. A manifest and its hash identify the collection, not just an individual file. This hash therefore does not duplicate an artifact hash.

Retries and test cases reuse the bundle. JSON is appropriate because there are no per-item edits or cross-bundle attachment queries in scope. Validate all artifact references before sealing; a JSON ID is not an enforced foreign key. A separate membership table becomes appropriate if per-item querying, replacement, or reference-aware deletion becomes a product need.

### 21. `workflow_runs` — keep

One row represents business execution on fixed code and inputs, with job, source evaluation case if applicable, retry ancestry, limits, elapsed time, and result/report. A completed run can correctly report invalid goods; it is not necessarily a passing evaluation.

Separating runs from jobs supports multiple test-case executions inside one evaluation job and records input-preparation failure before any run exists. Retry creates another row, not a reset of the old one. Aggregate budgets belong on the run because parallel visits share them. Historical applied limits must survive later default changes.

### 22. `step_executions` — keep logical trace; adapt executor fields

One row is one visit to a frozen node, with inputs, outputs, selected transitions, state, and error evidence. Loops require multiple rows for one node. Scheduling keys prevent duplicate logical visits. The global occurrence number orders scheduling; the new per-node visit number addresses fixtures independently of parallel scheduling order.

Structured branches must not independently enter the same node before their join; if that restriction changes, fixture addresses need branch context too. Bounded retries remain attached to one visit. Custom attempt tokens/history are conditional on retry ownership; do not duplicate an executor's authoritative retry ledger. Large payloads belong in artifacts.

### 23. `human_requests` — keep as a one-to-one extension

One row is the prompt, response contract, pending/answered/cancelled state, and accepted answer for one step visit. A separate endpoint can list pending questions and atomically accept one response. The unique step reference prevents multiple conflicting requests for that visit.

Embedding this on the step row is a valid smaller alternative. Prefer the extension because only human visits need these fields, the record has a specific actionable lifecycle, and manual responses must be distinguished from fixture responses. This is an ergonomic boundary, not a claim that nullable columns are intrinsically slow.

### 24. `parallel_groups` — conditional physical table

One group identifies a split occurrence, its paired merge, expected completion state, and eventual merge occurrence. A node-level completed flag cannot distinguish successive loops.

Keep this table if the application runtime owns coordination. If the executor durably owns it, consume its authoritative state and retain an idempotent history projection only if needed for the UI. Do not independently schedule merges from both. The logical identity is required; this particular physical representation is not final.

### 25. `parallel_branches` — conditional physical table

One row records an expected branch's entry connection, progress, arrival, and output within one group. With database-owned coordination, rows allow independent completion and unique arrivals; a shared group JSON object would serialize all branch updates and weaken relational constraints.

With executor-owned branches, use the executor's branch identity/history instead. Choose this together with `parallel_groups` and adapt step branch references accordingly. Never remove the representation without preserving per-occurrence join correctness, failed-branch diagnostics, and duplicate-arrival handling.

## Cross-cutting schema decisions

| Choice | Justification and limit |
| --- | --- |
| One application database namespace initially | The four domains are documentation groups, not a requirement for four PostgreSQL schemas or one schema per customer. Namespace separation adds no necessary demo behavior. Select an exposed/private namespace and grants during implementation; permissions scope being deferred does not authorize unrestricted database writes. |
| UUID identity | Stable references across browser drafts, background work, and artifacts. No claimed performance advantage over integer keys; identity format can change before migrations if measured needs justify it. |
| Explicit `workflow_id` on owned children | Supports workflow filtering and composite ownership constraints without repeated joins. It is deliberate denormalization, constrained against the parent rather than trusted as a free-standing label. It is not tenant isolation. |
| Composite ownership keys | `(workflow_id, id)` and selected `(run_id, id)` references prevent legal IDs from being linked in the wrong context. Add supporting uniqueness only where needed by actual foreign keys/query paths. |
| Text states with checks | Finite states remain database-validated without a lookup table per enum. State combinations and transitions require explicit mutation rules too. |
| `timestamptz`, revisions, version numbers | Timestamps support history; revisions detect conflicting edits; version numbers label immutable generations. None substitutes for the others. |
| Validated JSON | Use for variable config, immutable snapshots/manifests, and bounded owned payloads. Declare contracts and limits; do not place searchable independent relationships in arbitrary JSON by habit. |
| Soft deletion of draft graph elements | Keeps historical anchors/identities. All active queries and freeze validation must filter deleted elements. This is not a default to soft-delete every table or permission to retain sensitive files indefinitely. |
| Short workflow lock for canvas mutations | Coordinates edits, review, and freeze on one board. Different workflows remain independent; same-board write concurrency is intentionally limited. No network/LLM work inside the transaction. |
| Separate protected test/write authority | Repair cannot edit expected answers or acceptance evidence. Required for credible self-healing; UI disabling and model instructions alone are insufficient. |
| Selective stored summaries | Thread status, final verdict, run budgets, and session baseline speed actionable queries. Mutations must update them with their evidence; avoid new cached totals until needed. |
| Immutability boundaries | Freeze, plan approval, suite lock, and artifact readiness constrain further writes, including relevant children. “Immutable” must be enforced in database/controlled service access, not merely described in a field name. |

PostgreSQL supplies primary/unique and foreign-key constraints; ordinary row checks cannot enforce arbitrary graph-wide rules. Primary/unique keys create supporting indexes, while referencing foreign-key columns do not automatically receive their own indexes. These details inform, rather than replace, the application-specific decisions above. [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

JSON does not eliminate contention: updating JSON still locks its containing row. This supports keeping independently edited nodes/messages/results separate, while leaving immutable aggregates together. [PostgreSQL JSON](https://www.postgresql.org/docs/current/datatype-json.html)

## Query and index rationale

| Operation | Starting access path | Tradeoff |
| --- | --- | --- |
| List recent workflows | `(updated_at DESC, id DESC)` | Supports stable pagination; not a substitute for future tenant filtering. |
| Load a board | Nodes/connections by `workflow_id` | Existing workflow-prefixed keys may suffice; avoid duplicate indexes. Loading inherently costs at least the returned graph size. |
| Find adjacent routes | Active connections by workflow/source and workflow/target | Supports traversal and deletion; two indexes add write cost because two directions are queried. |
| Check freeze blockers | Partial index on workflow for open finding threads | Directly matches a repeated gate; no need to scan every old message. |
| Admit background operation | Unique active-job index per workflow | Enforces the chosen demo concurrency rule; cannot itself recover workers. |
| Load plan/suite/results | Parent-prefixed unique keys such as plan/node, suite/case key, evaluation/case | Enforce identity and serve the parent collection without redundant indexes. |
| Inspect run/history | Run/occurrence and workflow/time indexes | Paginate histories and exclude large payloads from list queries. |
| Complete a branch/response | Unique group/entry edge, split occurrence, and human step references | Duplicate delivery cannot create a second logical completion. |

Partial indexes must match the intended query predicates; verify actual query plans rather than adding indexes to every column. [PostgreSQL partial indexes](https://www.postgresql.org/docs/current/indexes-partial.html)

## Choices deliberately not made

- No invoice/good/CoA tables yet: these are typed outputs within a workflow result, not independently edited business records or cross-shipment search entities in this product. Add relational domain tables if those operations become requirements.
- No graph database: known board loading, node editing, and bounded traversal do not demonstrate a need for another datastore.
- No per-node-type, per-file-format, per-code-file, or per-assertion tables without corresponding independent operations.
- No user/team/permissions schema in the demo proposal; public multi-customer deployment requires an explicit isolation/access design first.
- No generalized event sourcing, global test library, reused human approval cache, post-freeze revisions, or failed-step resume.
- No speculative JSON search indexes, partitioning, sharding, or assertion of production readiness based on row count.

## What remains unresolved and how to resolve it

1. **Executor ownership:** prototype one generated project, one paused human step, a repeated parallel split, and cancellation/recovery. Choose a single scheduling authority, then finalize conditional tables/fields. This is the main architecture decision, not another product interview.
2. **JSON contracts:** specify node-type config, frozen graph, manifest, handler input/output, and check-result schemas with format versions and size limits. Current descriptions are design intent, not complete runtime validators.
3. **Workload and retention:** estimate active workflows, edits per board, cases/runs per day, visits per run, artifact sizes, and retention. Runtime traces grow much faster than draft nodes. Measure representative queries and mutation contention before claiming capacity.
4. **Deployment boundary:** select concrete database grants, storage access, job dispatch, sandbox, and credential handling. Workflow foreign keys do not authenticate users; protected grader records need actual enforcement.
5. **Migration verification:** translate the proposal into DDL/functions, test cross-owner/run links, state transitions, immutable children, races, and crash recovery. Cyclic references such as workflow/active-review require ordered table creation followed by the relevant foreign keys.

The model is now defensible as a scoped proposal with explicit alternatives and unresolved physical choices. It is not justified to call every field final, to equate 25 tables with scalability, or to implement a second runtime solely to preserve this count.

## Related specifications

- [Canvas fields and constraints](../.plans/meridian-canvas-schema-spec.md)
- [Review fields and constraints](../.plans/meridian-review-schema-spec.md)
- [Engineering/evaluation fields and constraints](../.plans/meridian-engineering-schema-spec.md)
- [Runtime/artifact fields and constraints](../.plans/meridian-runtime-schema-spec.md)
- [Architecture and diagrams](architecture.md)
- [Verification plan](verification.md)

## Implementation checkpoint: review and handoff

Migrations 003–004 implement `review_runs`, `discussion_threads`, `discussion_messages`, and `thread_anchors`. Missing-outcome clarification uses a dedicated thread kind within the active review; it does not need a separate table with the same conversation fields. Thread messages hold both replies and append-only disposition events, while the thread stores its current state for efficient freeze checks. Composite foreign keys enforce same-workflow references; parent-message keys enforce same-thread replies. The active-review partial unique index and workflow pointer prevent overlapping reviews.

Live editing remains relational. Review input and frozen handoff use immutable JSON snapshots because their whole-document identity matters more than per-node mutation; this duplication preserves the exact content judged or approved. Large historical snapshots are excluded from routine review-list responses. Workflow-scoped indexes support comment reads and recent-run lists. Model calls occur outside database transactions, and cancelled/stale results are rejected when publishing. Temporal owns execution; no SQL lease queue was introduced.

The executable schema and behavior take precedence over earlier proposed field names. The implemented flow and its limits are traced in `../specs/review-handoff.md`.

## Implementation checkpoint: runtime

Migration 007 implements `input_bundles`, `workflow_runs`, `step_executions`, and `human_requests`. Immutable bundle JSON is read as one captured aggregate; mutable per-visit records remain relational. Same-workflow and same-run foreign keys prevent history from crossing ownership boundaries. Controlled mutations additionally validate each input-output reference against a completed visit in the same run. Sealed manifests and terminal history have database immutability guards.

Temporal owns parallel coordination, so the conditional `parallel_groups`/`parallel_branches` tables were omitted. `branch_ref` identifies a split occurrence and entry connection for diagnostics. This avoids another scheduler while preserving distinct loop visits. Step attempt tokens fence stale publication; they do not claim SQL work or duplicate Temporal's retry policy. An answered human row doubles as a durable signal-delivery intent, so saving the response cannot lose its continuation during an app/worker outage.

Unique run/scheduling keys and run/node/visit keys serve idempotency and ordered-history queries. Runs use workflow/time and job indexes. Pending human requests and undelivered answers use partial indexes matching their polling predicates. Outputs are bounded to 128 KB; the run stores its outcome step reference rather than duplicating that payload. Runtime is limited to 100 scheduled attempts, so a selected run's full trace is bounded. Longer-term retention and production workload sizing remain future work.

Live restart recovery and local behavior checks are recorded in the [runtime guide](workflow-runtime.md). These establish the chosen executor boundary, not production traffic capacity. Evaluation-case relationships will be added with the evaluation migration; no placeholder FK points at nonexistent suite tables.
