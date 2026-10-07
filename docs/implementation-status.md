# Implementation scope and evidence

Updated as features land. An unchecked item is not complete, even if supporting code exists.

## Authoritative context

The original assignment and updated agent notes were reread in Chrome on October 7. They require React, Temporal, Composio, Supabase; anchored AI comments; at least two review rounds in the demo; immutable spec; a reusable code-first agent scaffold; real generated code; fixed-output evaluations; and repair using the supplied inbox as the primary dataset.

The interview decisions in `.plans/` and revised PRDs refine that scope. Explicit user cuts take precedence: manually select existing Gmail input; preview reports without sending; no post-freeze edits; no IDE-import round trip; no role/team permissions. Preserve open/answered/rejected/resolved comment labels in the UI while using the documented storage dispositions. Batch/CoA failures and invoice required-field failures are separate totals. Deduplicate invoices by invoice number and batches by batch number within each shipment.

## Selected services and execution ownership

- React/Next.js web app; Supabase Postgres and object storage.
- Temporal Cloud owns durable orchestration, retries, timers, human waits, and fork/join coordination.
- Vercel Sandbox isolates generated code. Supabase runtime rows are history/progress projections, not a competing scheduler; omit custom database worker leases.
- OpenAI supplies AI review and generation/repair; Composio supplies Gmail retrieval.
- Local/CI fixtures substitute external services explicitly. Passing fixture tests never counts as verification of live integration.
- A durable local PGlite database may support development before direct Supabase credentials are ready; production requires a configured Postgres connection. The same migrations and service tests must also pass against PostgreSQL in CI.

## Feature PRs

1. Persisted whiteboard and app foundation: workflows, nodes, connections, optimistic concurrency, canvas interactions, CI.
2. AI review and frozen handoff: anchored discussion, clarification, resolution history, immutable snapshot and guards; shared Temporal worker infrastructure.
3. Engineer plan and code generation: approved plans, inspectable versioned code, generation activities, isolated Sandbox execution.
4. Trusted runtime: captured inputs, visit history, isolated step execution, Temporal routing/human waits and recovery.
5. Trusted evaluations and bounded repair: versioned cases, result coverage, three attempts, regression-safe baseline, cancellation.
6. Gmail and complete demonstration: captured real inputs, document extraction, human steps/loops/parallelism, report preview, complete demo evidence.

Boundaries may move to keep each PR coherent. PR #1 conventions are incorporated before implementation. No direct main pushes.

## Acceptance checklist

- [x] Create/list/reopen independent workflows; edit node details, conditions, loop edges, paired parallel splits/merges. Whole-graph validation now runs at freeze.
- [x] Save/reload persists; stale edits preserve client text; cross-workflow references rejected.
- [x] Anchored AI review and clarification; cancel cannot publish late results; simplification findings are suggestions only.
- [x] Resolve/reject/reopen histories; atomic detail application; ordinary notes nonblocking; eligible deletion closure.
- [x] Freeze structural checks, completed-review minimum, closed findings, acknowledged later changes; immutable handoff.
- [x] Engineer plan approvals and explicit revisions; immutable mandatory human methods.
- [x] Generated downloadable source from reusable skeleton and frozen requirements; real background progress/cancellation.
- [ ] Locked independent expectations; revised suites preserve history; full-suite grading with errors/blockers distinguished.
- [ ] Repair actual code, keep every attempt, reject regressions, preserve baseline, stop at three attempts or required human decisions.
- [ ] Temporal durability and Sandbox isolation verified with live adapters.
- [ ] Gmail/Composio ingestion captures immutable messages/documents; verify all provided shipment ground truth, excluding mismatched-invoice scoring.
- [ ] Fresh human response per visit; new documents/new run; exclusive ambiguity errors; correct per-occurrence joins; bounded loops/time.
- [ ] Retry uses same code and inputs in a fresh linked run; preview-only report.
- [ ] Full browser demonstration from incomplete canvas through two AI reviews, freeze, generation, failure, repair, and final result.
- [ ] README/run instructions, design tradeoffs, PDF/Word handoff and recorded demo artifact.

## Evidence log

- Context assembly: original Notion assignment and updated agent notes read; PR #1 merged conventions reconciled with planning docs.
- Local service configuration inspected by key presence only. Composio/Temporal/Supabase settings exist; OpenAI key and database password are not present in `app/.env.local` at this checkpoint. User asked for local credential location; implementation can proceed independently.
- Credentials follow-up: OpenAI key and Supabase password are now present. Supabase connection verified with the provider's CA and certificate verification enabled; canvas migrations applied to the take-home database. OpenAI presence is not yet a live inference check.
- Whiteboard shell: three live variants inspected in Chrome; Compact workbench selected under Justin's instruction to make the choice autonomously. It keeps seven primitive types visible at laptop height. Picker files and alternate variants removed.
- Foundation: targeted relational edits, optimistic revisions, same-workflow constraints, RLS against direct anonymous REST access, and independent local test persistence implemented. A browser test exposed omitted PATCH fields receiving create defaults; update schemas now explicitly preserve absent fields.
- Foundation verification: lint/typecheck/production build pass, 10 local persistence/request tests pass, and both production-browser journeys pass (return-loop persistence and two-tab conflict recovery). PostgreSQL 17 and production-browser checks passed in PR #2 (merged); both scaffold and app checks are now required on main. Production dependency audit has no findings; the development lint dependency tree currently reports five advisories involving braces, with no compatible patch offered by npm audit.

- Review/handoff: 23 local tests and four production browser journeys pass. The browser flow performs two fixture review rounds, approves a detail edit, and freezes a persisted board. OpenAI + Temporal live verification completed successfully on a synthetic Supabase workflow using `gpt-5.4-mini`; no Gmail access or sending occurred.
- File placement: feature-specific server/UI folders, shared workflow persistence helpers, isolated integration adapters and a separate worker entry point are implemented and documented. Review messages, anchors and recent-run queries have workflow-scoped indexes.
- Live review continuation: two real OpenAI reviews completed on the synthetic workflow, with a saved customer answer, a manual outcome edit, recorded resolution, and a handoff acknowledgment for the later semantic edit. This verifies the review path only; generated agents, Gmail and full shipment evaluation remain unchecked above.

- PR #3 review/handoff merged after required scaffold and app CI passed (PostgreSQL 17, worker bundle, four browser journeys). Live synthetic handoff is frozen after two review rounds.
- Generation feature in progress: approved-plan revisions, mandatory-human guards, private artifact transport/integrity checks and exclusive/idempotent job lifecycle are implemented at the service layer. This initial service checkpoint had 30 passing tests; see the later generation milestone below for current UI and live verification.
- Vercel: dedicated `meridian-take-home` project linked using existing CLI access. A nonpersistent Node 24 sandbox ran successfully with denied network egress and no application keys, then stopped. This is infrastructure verification, not generated-agent execution.
- Storage configuration: Supabase Postgres is live; private object storage needs the existing server secret key. A nonblocking request asked for it in `.env.local`. Local artifact storage supports continued development while that is pending.

- Engineer interface: three live variants inspected in Chrome. Compact table selected because method/approval comparisons stay visible together; step requirements expand in place. Temporary picker and alternate variants removed.
- Generation verification: 35 local tests and five production-browser journeys pass, including source checkpoint reuse after a validation outage, late-cancellation fencing, cross-workflow download denial, explicit approvals, immutable revisions and ZIP delivery. Live method suggestions succeeded. Live OpenAI → Temporal → Vercel Sandbox generation subsequently completed; its code version is visible in Chrome with download and Not yet evaluated. The initial failed attempt remains in history.

- Live generation fixes: sandbox directory creation now creates the parent explicitly. Source generation uses an array of lines to avoid double-escaped line separators. Complete source is preserved as a version before syntax validation; a failing or incomplete check remains separate from code existence and never counts as correctness. Service tests cover expired-slot recovery when the worker is offline. Full agent execution/evaluation is still pending.

- PR #4 generation merged after both required CI checks passed at its final head.
- Runtime service milestone: migration 007 adds immutable captured inputs, runs, visits and human requests. Temporal owns per-occurrence fork/join state; no parallel coordination tables or competing SQL scheduler were added. Service/domain tests now total 47 and worker bundling passes. Runtime UI, suites and repair remain pending.
- Live runtime recovery: synthetic fixture code executed in Vercel Sandbox, paused at a mandatory approval, then resumed after worker restart. The response was saved while the worker was offline and delivered through the durable outbox. Run `8f8debcc-95ce-4baa-a2f6-ec0b73de3111` finished all three steps. This verifies the basic live execution/recovery path, not Gmail or shipment accuracy.
