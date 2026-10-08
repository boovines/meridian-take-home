# Meridian Studio technical handoff

Meridian Studio captures a process owner's requirements in a whiteboard, preserves their decisions in a frozen specification, and generates versioned code for an engineer to evaluate and repair. The import-receiving example reads existing Gmail packets and previews a report. The workflow platform remains reusable: invoice rules are supplied requirements for generated modules.

## Run the project

Use Node 24. In `app/`, run `npm ci`, configure `.env.local` from `.env.example`, and run `npm run db:migrate`. Start `npm run dev` and `npm run worker` in separate terminals. The app defaults to `http://127.0.0.1:3000`; use `npm run dev -- --port 3100` if needed. See `app/README.md` for the complete environment and TLS instructions.

Supabase stores application records. Temporal Cloud schedules durable work; its Node worker must keep running. OpenAI reviews, generates, interprets documents and repairs code. Composio reads the configured Gmail account. Vercel Sandbox runs generated code with denied network egress and no application credentials. Local artifact storage supports a laptop demo; hosting needs shared private storage, a persistent worker and access protection.

`npm run demo:seed -- --create --incomplete` creates a fresh example draft. Follow `docs/guides/demo.md` for two review rounds, handoff, implementation approval, Gmail capture, locked evaluations and repair. The app never sends a report email.

## The primitive set

| Primitive | What the process owner means |
| --- | --- |
| Trigger | The event or selected input that starts the process. |
| Information | Gather or interpret information needed by later work. |
| Task | Perform a piece of work and describe its result. |
| Check | Decide whether a condition is satisfied and where to continue. |
| Human handoff | Pause for a person's answer or judgment. |
| Human approval | Require an explicit approval or rejection before proceeding. |
| Outcome | The result that ends the process. |

These are business concepts rather than provider-specific tools. Instructions stay in plain language. Labeled connections describe conditions, including return paths. Exclusive splits require exactly one matching route, with an optional Otherwise path. Parallel splits have an explicit paired merge; each merge waits for that occurrence's branches. One trigger and reachable process blocks are required at freeze.

## Comments and frozen specifications

The AI reviewer looks for consequential ambiguity, missing behavior, inconsistent routing and steps that do not support the desired outcome. It may suggest a detail edit, but cannot rewrite the state machine. The process owner accepts, modifies or rejects suggestions. A false-positive review remains visible and can be rejected with an explanation.

Mutable `workflows`, `nodes` and `connections` support independent edits. A node row has a type, plain-language instructions, bounded configuration, position, routing mode and revision. Connections are the single source of adjacency; predecessor/successor arrays are not duplicated on node rows. Updates check expected revisions, and stale UI edits retain unsaved text.

`review_runs` captures the exact reviewed draft and model context. `discussion_threads` distinguishes AI findings, customer notes and outcome clarification. `discussion_messages` stores replies and decision history; parent message IDs support replies. `thread_anchors` allows one discussion to refer to multiple nodes or connections. Notes do not block freeze; open AI findings do. Resolution and an approved detail edit commit together.

`frozen_specs` stores the immutable graph and review evidence. Freeze atomically checks structure, at least one completed review, and closed findings. Later semantic edits require an acknowledgment if they have not been reviewed. The demo locks the board after handoff; customer decisions cannot be silently changed by generation or repair.

Separate rows are justified by independently updated lifecycles, not by treating every noun as a table. Nodes use indexed workflow lookups and targeted writes. Frozen graphs and captured manifests are JSON because they are immutable aggregates read as a unit. Large source files and generated projects live in artifact storage, with hashes and ownership metadata in the database. The executable schema contains 26 application tables; detailed constraints and indexes are in `app/migrations`.

## Generation and trusted repair

Approved plans, generated projects, input bundles and verified suites are separate versions. An evaluation always names its exact code and suite. Each run records step visits independently of the canvas node, so looping back creates a fresh visit and a fresh human response. Temporal owns scheduling and split/merge state; database rows provide history and inspection, rather than a second scheduler.

The generator writes actual Node modules against a reusable step contract. The host supplies captured inputs and prior step outputs. Agent steps may request a bounded document interpretation; generated code cannot retrieve arbitrary files, bypass human gates, send email, or grade itself. Full source is retained before syntax validation. A successful build is not a claim of business correctness.

The engineer explicitly starts repair. The frozen process, approved methods and locked expectations remain fixed. Each session allows three candidates. Every candidate completes the full suite before acceptance; it cannot become the next baseline if it breaks any previously passing assertion. A fully passing candidate must then complete three consecutive fresh full-suite passes with the same code, suite and recorded configuration before the session is confirmed. Confirmation stops on its first failure or inconclusive result. Rejected candidates retain their diagnosis, source and results. Failures that require a method, process or expectation change stop for an engineer decision.

## The canvas and code tradeoff

The canvas is useful for making business requirements and exceptions discussable with a process owner. Return paths require state-machine semantics; a strictly acyclic graph cannot express revisiting a step. In this implementation, generated JavaScript owns step logic and extraction prompts, so a coding agent can inspect and repair executable code using ordinary source diffs.

The host deliberately retains control of routing, approvals and evaluation. That makes a repair's authority clear, but limits architectural freedom: repair cannot invent a new branch or replace the approved plan. The download is a set of runnable step modules and its contract, not a standalone replacement for the trusted orchestration host. More complex processes may need a richer code-first orchestration layer with a reviewable mapping back to the business specification.

## Verification and further work

Required CI runs lint, type checking, a production build, Temporal workflow bundling, PostgreSQL persistence/domain tests and browser journeys with sanitized fixtures. Live provider checks are separate and never claimed as fixture-test evidence. The supplied dataset has passed once and failed on an unchanged fresh rerun, so historical success must not be presented as repeatability. The expanded suite preserves all original checks and adds source-inspected extraction diagnostics. See [implementation status](../implementation-status.md) for every current measured result and the confirmation outcome. Source observations authored by Codex are labeled as such; they are not claimed as independent human verification.

The next investments would be broader independent extraction labels, selective retrieval of evidence beyond bounded previews, cost/quality observability, and production access/retention controls. I would then add versioned workflow revisions after handoff and a repository round trip. Continuous Gmail watching, automatic report delivery, arbitrary parallel overlap and process mining remain outside the demo. I would measure execution-history growth before choosing partitioning or sharding; node-row count alone is not a reason to abandon a relational model.

## Assessment against the assignment

| Criterion | Demonstrated behavior | Practical limit |
| --- | --- | --- |
| Primitive design | Seven business-oriented block types; labeled exclusive routes, loops, and paired parallel branches. The shipment flow uses parallel readers; the small returns flow uses four blocks. | Customers still edit graph changes manually; broader usability testing has not been performed. |
| Comment/revision loop | Live returns review clarified the inclusive 30-day boundary, invalid-input behavior and identifier propagation. The instructions changed before freeze, with recorded explanations. The shipment report also changed after a consequential finding. | Resolution expresses the process owner's decision; the AI does not prove semantic completeness. |
| Frozen spec | Instructions, desired outcome, transitions, node configuration and review evidence are immutable. Engineer methods and human gates are explicit. Generation reads that artifact rather than relying on this chat. | Post-freeze revisions are deferred; newly discovered business requirements need a new workflow in the demo. |
| Repository organization | UI, pure contracts, transactional services, adapters and Temporal orchestration have explicit boundaries. SQL migrations define persistence; large/private evidence stays outside source. | No production traffic benchmark or retention policy is claimed. |
| Communication | Setup, current architecture, a short recording sequence and a dated evidence log are linked from the README. The report separates live execution, fixture tests, synthetic cases and source-inspected labels. | Earlier recordings show historical states; use the latest evidence when presenting accuracy. |
| Scope judgment | Existing small SOPs demonstrate reuse. Report sending, repository import, post-freeze edits and hosted access are deferred. Inference is budgeted and repair is bounded. | LlamaCloud remains an optional candidate until credentials and live comparison succeed. Passing CI does not authorize merging. |

The local walkthrough was operated by Codex through Chrome with real providers. It demonstrates application behavior, not an independent customer usability study or human verification of every evaluation label.
