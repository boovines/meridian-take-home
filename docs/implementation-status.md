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
2. AI review and frozen handoff: anchored discussion, clarification, resolution history, immutable snapshot and guards.
3. Engineer plan and code generation: approved plans, inspectable versioned code, Temporal worker, isolated Sandbox execution.
4. Trusted evaluations and bounded repair: versioned cases, result coverage, three attempts, regression-safe baseline, cancellation.
5. Gmail and complete demonstration: captured real inputs, document extraction, human steps/loops/parallelism, report preview, complete demo evidence.

Boundaries may move to keep each PR coherent. PR #1 conventions are incorporated before implementation. No direct main pushes.

## Acceptance checklist

- [x] Create/list/reopen independent workflows; edit node details, conditions, loop edges, paired parallel splits/merges. Whole-graph freeze validation belongs to the next feature.
- [x] Save/reload persists; stale edits preserve client text; cross-workflow references rejected.
- [ ] Anchored AI review and clarification; cancel cannot publish late results; simplification findings are suggestions only.
- [ ] Resolve/reject/reopen histories; atomic detail application; ordinary notes nonblocking; eligible deletion closure.
- [ ] Freeze structural checks, completed-review minimum, closed findings, acknowledged later changes; immutable handoff.
- [ ] Engineer plan approvals and explicit revisions; immutable mandatory human methods.
- [ ] Generated downloadable source from reusable skeleton and frozen requirements; real background progress/cancellation.
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
- Foundation verification: lint/typecheck/production build pass, 10 local persistence/request tests pass, and both production-browser journeys pass (return-loop persistence and two-tab conflict recovery). PostgreSQL verification is wired into CI and awaits the first PR run. Production dependency audit has no findings; the development lint dependency tree currently reports five advisories involving braces, with no compatible patch offered by npm audit.
