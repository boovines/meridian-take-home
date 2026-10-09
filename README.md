# Meridian Studio

A process owner maps a workflow, resolves anchored AI findings, and freezes a specification. An engineer approves Code, Agent or Human methods, generates inspectable step modules, evaluates them against locked expectations, and starts bounded repair. The import-receiving example reads existing Gmail documents and previews a shipment report; its business rules are supplied to generated code, not hardcoded into the platform.

This repository implements the [Meridian take-home assignment](https://app.notion.com/p/Meridian-Take-Home-Project-3adfdc07926d80dc9b59f9ce64e07155). Start with **[setup](app/README.md#run-locally)**, then the **[end-to-end walkthrough](docs/guides/demo.md)**. The [documentation index](docs/README.md) links the PRDs, diagrams, feature contracts and schema rationale.

## Run

Use **Node 24 and npm**. Choose one setup path:

- **Local fixture preview:** `cd app`, `npm ci`, then the [fixture command](app/README.md#local-fixture-preview-no-service-credentials). It uses local PGlite and synthetic providers. No Temporal worker is needed; this does not demonstrate real AI or Gmail.
- **Live workflow:** follow the [service configuration](app/README.md#live-services), apply all migrations, then run `npm run dev` and `npm run worker` in separate terminals from `app/`. The web app defaults to `http://127.0.0.1:3000`.

The live stack is React/Next.js, Supabase Postgres, Temporal Cloud with a persistent Node worker, Composio Gmail, OpenAI, and Vercel Sandbox for generated execution. The [setup reference](app/README.md#live-services) covers credentials, verified database TLS, artifact storage and Sandbox access. Hosting also requires access protection and shared private storage; the current demo binds to localhost. Gmail is read-only and reports are not sent.

## Primitive set and rationale

The canvas has seven business concepts, defined in [the canvas contract](app/src/domain/canvas.ts). Implementation method is chosen later, so customers do not have to decide how software should execute each step.

| Primitive | Meaning and reason for keeping it separate |
| --- | --- |
| Trigger | Identifies the input or event that starts a run. |
| Information | Gathers or interprets evidence needed by later steps. |
| Task | Performs work and produces a result. |
| Check | Makes a business decision and selects the next path. |
| Human handoff | Pauses for a person's information or judgment. |
| Human approval | Requires an explicit approval or rejection. |
| Outcome | Defines the result delivered at the end. |

Connections express conditions and return paths. Parallel splits have an explicitly paired merge. One trigger, reachable blocks and supported routing are required at freeze; see [graph validation](app/src/domain/validate-graph.ts) and its [tests](app/tests/graph.test.ts). Optional [guided scoping](docs/features/guided-workflow-scaffolding.md) turns plain-text notes and a conversation into an initial graph preview; the customer explicitly applies it and still completes ordinary review.

## Comments, revisions and frozen data

Mutable nodes and connections use separate rows with optimistic revisions for targeted edits. `discussion_threads`, append-only `discussion_messages`, and `thread_anchors` support findings and notes attached to multiple blocks or connections. The UI distinguishes Open, Answered, Rejected and Resolved. Replies alone do not approve proposed edits, and ordinary notes do not block freeze.

Freeze saves the graph, desired outcome and review decisions as immutable `frozen_specs` JSON. An explicit process revision opens a new working draft while preserving the earlier spec, plans, code and results. The new handoff requires its own review and produces an unapproved implementation plan; old passes do not validate a changed process. See the [review contract](docs/features/review-handoff.md), [revision behavior](docs/features/engineer-generation.md#engineer-requested-process-revisions), [SQL migrations](app/migrations), and [revision persistence tests](app/tests/process-revisions.test.ts).

Separate rows fit independently edited records; snapshots fit immutable aggregates consumed together. Files and large traces live in artifact storage with ownership and hashes in the database. [Data-model rationale](docs/architecture/data-model.md) explains constraints, indexes and alternatives; migrations define the executable schema.

## Why a graph for requirements and code for execution?

A state machine can return to a previous step when information is missing; a DAG cannot represent that loop. The canvas makes those business decisions discussable with a nontechnical owner. The generated implementation is ordinary JavaScript, which a coding agent can inspect, diff and repair. [Project assembly](app/src/server/engineering/project.ts) supplies the shared contract and [repair generation](app/src/server/repairs/generation-service.ts) retains versioned source.

This is a deliberate hybrid. Temporal and the trusted host retain routing, human gates and grading; generated modules implement steps and request permitted tools. Repair can change code and prompts within approved methods, but cannot change the frozen process or expected answers. The download therefore depends on the host contract—it is not a standalone orchestration replacement. See [system boundaries](docs/architecture/overview.md) and the [repair contract](docs/features/bounded-repair.md).

## What is verified?

| Claim | Evidence and limit |
| --- | --- |
| Customer authoring, review and immutable handoff | [Feature contracts](docs/README.md#implemented-features), [browser journeys](app/tests/browser), and [migrations](app/migrations). Fixture checks establish the covered behavior, not live model quality. |
| Generated execution and bounded repair | [Runtime](docs/features/workflow-runtime.md), [repair acceptance rules](docs/features/bounded-repair.md), and [repair tests](app/tests/repairs.test.ts). A build pass is not a business-accuracy result. |
| Historical shipment repeatability | The [dated evidence log](docs/implementation-status.md) records three fresh v17 runs of 24 cases/207 assertions under the same settings. That result belongs to that code, suite and configuration; it does not establish accuracy for later versions, unseen documents or every source citation. |
| Assignment demonstration | The [requirement audit](docs/guides/take-home-minimum.md) identifies recorded review rounds, frozen spec, generated code, evaluations and handoff artifacts. Historical recordings are separate from current checkout verification. |

A repair candidate advances its baseline only after full-suite non-regression checks. Confirmation requires three consecutive fresh full-suite passes for that candidate and configuration. Exposed cases are regression tests, not held-out validation. See the [verification guide](docs/verification.md) for the test boundaries and commands.

## Repository layout

```text
app/
  src/app/         Pages and thin HTTP endpoints
  src/components/  UI grouped by feature
  src/domain/      Typed contracts and pure validation/routing/grading rules
  src/server/      Transactional services and provider adapters
  src/worker/      Temporal workflows and I/O activities
  migrations/      Ordered executable schema
  tests/           Domain/persistence tests, browser journeys and fixtures
  scripts/         Operator commands, live checks and example setup
  README.md        Setup, commands and detailed module map
docs/
  product/         PRDs and approved specifications
  architecture/    System diagrams and schema rationale
  features/        Current behavior and failure contracts
  guides/          Demo, assignment audit and handoff
  archive/         Superseded interview/design records
.github/workflows/ CI using sanitized fixtures
.runtime/, work/   Ignored local artifacts and scratch work
```

The [module map](app/README.md#file-map) explains ownership. Follow [CONTRIBUTING.md](CONTRIBUTING.md): focused feature branches, actual verification, open PRs and explicit approval before merging. Never commit credentials, mailbox content or real shipment documents.

## Future work (outside demo scope)

Priorities follow the observed limits in the [evidence log](docs/implementation-status.md) and [handoff](docs/guides/handoff.md#verification-and-further-work):

- **Stronger extraction evidence and independent validation.** Verify that citations support their values, add independently reviewed negative cases, and measure cost and repeatability on fresh documents before claiming general reliability.
- **Production access and operations.** Add authenticated organization permissions, retention, deployment controls and measured load testing; benchmark history growth before choosing partitioning or sharding.
- **Repository round trip.** Import IDE edits into immutable code versions and evaluate the exact imported revision. Today the app previews/downloads code and evaluates app-managed versions.
- **Richer process authoring.** Add multiple triggers, overlapping parallel sections and collaborative revision branches. One expert-controlled revision draft and explicitly paired parallel sections already exist.
- **Broader integrations.** Add SOP-file ingestion and process mining. Plain-text notes and approved initial graph generation already exist. Continuous Gmail monitoring and actual report delivery remain deferred.
- **More flexible run recovery.** Add document replacement during human waits and general failed-step resume. Today changed documents create a new input bundle; an explicit retry starts a linked run from the beginning.
