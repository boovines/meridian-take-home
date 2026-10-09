# Meridian Studio

A process owner maps a workflow, resolves anchored AI findings, and freezes a handoff. An engineer approves how its steps are implemented, generates inspectable code, evaluates it against fixed expectations, and starts bounded repair sessions. The import-receiving example reads captured Gmail documents and previews a shipment report.

Start with the [documentation index](docs/README.md), [app setup](app/README.md), the [demo walkthrough](docs/guides/demo.md), the [technical handoff](docs/guides/handoff.md), and [verified implementation status](docs/implementation-status.md). Live checks and fixture tests are reported separately.

The [take-home minimum audit](docs/guides/take-home-minimum.md) maps the assignment to concrete product evidence and the recording sequence. The complete product loop is implemented and demonstrated. Historical shipment v17 met the demo repeatability gate: three consecutive fresh runs each passed 24/24 cases and 207/207 assertions under identical recorded settings. This establishes the locked-suite result, not unseen-document reliability or correctness of every source citation.

## Run

Use Node 24. From `app/`, run `npm ci`, configure `.env.local` using `.env.example`, and apply remote migrations with `npm run db:migrate`. Run `npm run dev` and `npm run worker` in separate terminals. The worker uses Temporal Cloud; generated code runs in Vercel Sandbox. See the app README for Supabase TLS, private artifact storage, provider setup, and local fixture development.

The demo binds to localhost. Hosting requires a persistent worker, shared private artifact storage, and access protection; team/role permissions are outside scope. Reports are previews and Gmail access is read-only.

## Repository layout

```text
app/
  src/app/           Pages and thin HTTP endpoints
  src/components/    UI grouped by canvas, review, engineering, evaluation, repair, runtime
  src/domain/        Typed contracts and pure validation/routing/grading rules
  src/server/        Transactional feature services and separate provider adapters
  src/worker/        Deterministic Temporal workflows and I/O activities
  migrations/        Ordered executable database schema
  tests/             Service/domain tests, browser journeys, sanitized fixtures
  scripts/           Operator commands and explicit live service checks
    demo/            Example business requirements, draft seeding, suite import
  README.md          Setup, commands, module map, integration details

docs/
  README.md          Documentation entry point and authority map
  product/           Product requirements
  architecture/      System diagrams and data-model rationale
  features/          Implemented behavior and operator guidance
  guides/            Demo and handoff walkthroughs
  archive/interviews/ Original interview decisions and schema proposals
.github/workflows/   Required CI without live model/Gmail credentials
.runtime/            Ignored inputs, artifacts, databases and local investigation
```

Application files follow feature boundaries. API handlers validate requests and delegate; services own transactions; provider adapters own network calls. Temporal owns execution scheduling. The example's shipment rules are requirements for generated code, not special cases built into the reusable runtime. The full [file map](app/README.md#file-map) explains each folder.

## Design and data model

The revised [Whiteboard PRD](docs/product/whiteboard.md) and [Self-Healing Agent PRD](docs/product/self-healing-agent.md) retain product decisions. [Architecture and diagrams](docs/architecture/overview.md) describe boundaries and invariants. The [data-model decision audit](docs/architecture/data-model.md) explains table boundaries, keys, indexes and alternatives; `app/migrations` is the executable schema. [Archived interview](docs/archive/interviews/README.md) proposals include conditional tables that were intentionally omitted once Temporal became the scheduling authority.

Mutable nodes and connections have independent rows and optimistic revisions. Immutable snapshots, input manifests and generated artifacts retain the exact context used by reviews, runs and evaluations. The frozen process, approved plan and locked expectations cannot be rewritten by a repair agent. Each repair session retains every candidate and only advances its baseline after full-suite regression checks. Confirmation requires three consecutive fresh full-suite passes for the same candidate and configuration; one historical pass is insufficient.

## Verification and development

From `app/`, run `npm run lint`, `npm run typecheck`, `npm test`, `npm run worker:check`, `npm run build`, and `npm run test:browser`. Install the browser once with `npx playwright install chromium`. GitHub Actions runs these checks on ordinary and stacked PRs, with the full test suite on both PGlite and PostgreSQL 17 and isolated local storage for browser journeys. Separate check results and downloadable test reports identify failures; the required `app` gate requires every application check to pass. Live scripts are opt-in and consume configured provider resources.

Follow [CONTRIBUTING.md](CONTRIBUTING.md): feature branches, focused PRs, actual verification, and explicit approval before merging. Feature PRs remain open as a dependent stack; passing CI is not merge permission. Never commit credentials, mailbox content, or real shipment documents. The [evidence log](docs/implementation-status.md) distinguishes implemented behavior, verified integrations, and remaining limitations.

## Future work (outside demo scope)

- **Branch and collaborate on process revisions.** One expert-controlled revision draft is implemented; simultaneous branches, merging, notifications and role permissions remain future work.
- **Import IDE edits and connect repositories.** For the demo, engineers can preview generated code and diffs and download the project; evaluation and repair operate on app-managed code versions. Later, support importing external edits or synchronizing a Git repository, with each evaluation tied to the exact code version tested.
- **Continuously monitor Gmail.** Demo runs start from an explicitly selected shipment email or shipment number. Automatic runs on new mail are deferred.
- **Support multiple workflow triggers.** The demo requires exactly one active Trigger block when freezing a workflow. Later, support multiple entry points with explicit trigger selection and input contracts for each entry point.
- **Support overlapping parallel sections.** The demo requires explicitly paired parallel splits and merges. More general overlapping parallel routing is deferred.
- **Deliver report emails.** The demo captures and previews the intended report. Actual email delivery is deferred.
- **Generate maps from existing sources.** SOP upload for an initial canvas is a low-priority stretch; automated process mining from business systems is outside demo scope.
- **Verify citation meaning.** Page bounds and artifact identity do not prove that a cited page supports an extracted value. A live spot-check found a correct batch value with an incorrect page citation outside the locked suite; add source-verified citation expectations before claiming fully auditable extraction.
- **Benchmark extraction more broadly.** Start with targeted checks on representative demo PDFs; broad comparisons across OCR systems and document collections are deferred.
- **Change documents during a paused run.** Human responses are text or decisions in the demo. New documents require a new input bundle and run; in-run document uploads and dependency-aware reprocessing are deferred.
- **Resume failed runs from checkpoints.** A user-requested retry starts from the beginning with the same code and inputs, linked to the failed run. General failed-step resume is deferred.
