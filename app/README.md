# Application

Next.js/React application for the Meridian take-home: process whiteboards, AI review, frozen handoff, generated agents, Gmail input capture, isolated execution, trusted evaluations and bounded repair. Start with the [documentation index](../docs/README.md). Measured verification and remaining limitations are tracked in [implementation status](../docs/implementation-status.md).

## Run locally

Use Node 24 (the version used by CI and generated Sandbox projects) and npm. Run commands below from `app/`. Install dependencies once with `npm ci`. Choose a fixture preview or live services; do not combine their database modes.

### Local fixture preview (no service credentials)

```sh
npm ci
MERIDIAN_DATABASE=local \
MERIDIAN_LOCAL_DEMO=true \
MERIDIAN_REVIEW_PROVIDER=fixture \
MERIDIAN_SCOPING_PROVIDER=fixture \
MERIDIAN_ENGINEERING_PROVIDER=fixture \
npm run dev
```

Open `http://127.0.0.1:3000`. This mode automatically migrates an ignored PGlite database in `../.runtime/database`, stores artifacts in `../.runtime/artifacts`, and uses deterministic fixtures for scoping, review, generation, evaluation and repair. Do not start the Temporal worker or run `db:check`/`db:migrate` for this mode; those database commands require a configured PostgreSQL connection. Gmail capture and selected-email orchestration still require live services. Fixture results are labeled and are not AI-quality, Sandbox or Temporal evidence.

`MERIDIAN_DATABASE=local` alone only selects local storage; it does not substitute model providers. The full flag combination above is required. `LOCAL_DATABASE_PATH` and `LOCAL_ARTIFACT_PATH` can isolate another local preview. Use only one app process per PGlite directory.

Evidence: [database selection/migration](src/server/database.ts), [review dispatch](src/server/reviews/dispatch.ts), [scoping dispatch](src/server/scoping/dispatch.ts), [engineering dispatch](src/server/engineering/dispatch.ts), and [browser fixture configuration](playwright.config.ts).

### Live services

Create `.env.local` from the example only if it does not already exist, then fill in the required settings **before** running checks:

```sh
test -f .env.local || cp .env.example .env.local
```

| Service | Configuration and purpose |
| --- | --- |
| Supabase Postgres | `DATABASE_URL`, or `SUPABASE_DB_HOST`, `SUPABASE_DB_USER`, `SUPABASE_DB_PASSWORD`, optional port/name and `SUPABASE_DB_SSL_ROOT_CERT`. Used by both web and worker. |
| OpenAI | `OPENAI_API_KEY`; model overrides are `OPENAI_REVIEW_MODEL`, `OPENAI_SCOPING_MODEL`, `OPENAI_ENGINEERING_MODEL`, `OPENAI_RUNTIME_MODEL`. The example defaults to `gpt-5.4-mini`; recorded results do not transfer between models. |
| Temporal Cloud | `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY`, `TEMPORAL_TLS=true`, and a matching `TEMPORAL_TASK_QUEUE` in both processes. The worker executes durable work. |
| Composio Gmail | `COMPOSIO_API_KEY` and `COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID` for an existing read-only Gmail connection. Needed for real email capture, not canvas editing. |
| Vercel Sandbox | Link the dedicated Vercel project and configure valid Sandbox credentials through the SDK's OIDC flow. See [Sandbox setup](#sandbox-access). Needed to validate and run generated code. |
| Artifacts | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_SERVICE_ROLE_KEY`) and `SUPABASE_ARTIFACT_BUCKET` for private storage. Local development can instead share an absolute `LOCAL_ARTIFACT_PATH` between web and worker. Production requires private Supabase storage. |
| Optional inference guard | Configure both `INFERENCE_BUDGET_USD` and an absolute `INFERENCE_BUDGET_LEDGER`; see [spending guard](#inference-spending-guard) before enabling it with the default models. |

Clear the `MERIDIAN_*` fixture/local flags for live use. `DATABASE_URL` takes precedence over separate Supabase fields. Download the project CA from Supabase Database Settings and set `SUPABASE_DB_SSL_ROOT_CERT` to its absolute path. For a URL, specify `sslmode=verify-full` and `sslrootcert`; do not disable TLS verification. The transaction pooler can use `SUPABASE_DB_PORT=6543` with its pooler host/user. These settings are parsed by [database.ts](src/server/database.ts); Temporal settings are parsed by [temporal-config.ts](src/server/integrations/temporal-config.ts).

```sh
npm run db:check
npm run db:migrate
# When using Supabase artifact storage:
npm run storage:setup
# Terminal 1:
npm run dev
```

In a second terminal, from the **same `app/` directory** with the same database, artifact location and provider configuration:

```sh
npm run worker
```

Open `http://127.0.0.1:3000`. For another port, use `npm run dev -- --port 3100`. Apply **all** migrations through `db:migrate` rather than selecting a historical migration number. Let active operations finish or cancel them through the app before replacing a worker. Different checkouts must not accidentally consume the same task queue with different code or point historical local artifacts at a new directory.

`db:check` only checks connectivity; `db:migrate` changes the selected database and `storage:setup` creates/verifies the private bucket. For a local production build, use `npm run build` then `npm run start` with the same live configuration. Vercel can host the web/API, but the Temporal worker needs a separate persistent Node process. Hosting requires shared private artifacts and access protection; role/team permissions are not implemented. The [storage adapter](src/server/artifacts/storage.ts) enforces private storage in production; RLS denies direct anonymous table access.

Each web or worker process opens at most four PostgreSQL connections. Transactions apply ten-second statement and thirty-second idle limits. Account for all deployed processes when sizing the pool. These limits protect database locks; they do not bound model execution time.

## Verify changes

```sh
npm run docs:check
npm run lint
npm run typecheck
npm test
npm run worker:check
npm run build
npx playwright install chromium
npm run test:browser
```

`npm test` uses an in-memory PGlite database by default. To exercise PostgreSQL locally, point `TEST_DATABASE_URL` at an isolated localhost database. The tests reject remote database hosts. Browser tests start a production server on port 3101 with a separate local database in `../.runtime/browser-tests`; they never use `.env.local`'s Supabase connection. Live service checks are separate from these fixture tests.

Worker cancellation tests also start a temporary local Temporal server through the official testing SDK. The SDK downloads and caches its development-server binary on first use; tests tear it down afterward and never connect to the configured cloud namespace. This regression runs in the same `npm test` command in GitHub Actions.

CI exposes separate static/worker, full-suite PGlite, full-suite PostgreSQL 17, and production-build/browser checks. Browser journeys cover authoring, review, generation, evaluation, human responses and report preview. Every open PR is eligible, including a stacked PR based on another feature branch. The existing required `app` check aggregates these results and fails if any check fails, is cancelled, or is skipped. It needs no Gmail or model credentials. Download JUnit results and browser failure traces from the workflow's artifacts; see [the check map](../docs/verification.md).

## Implementation boundaries

`src/domain` holds contracts; `src/server` holds database adapters and transactional services; `src/app/api` holds HTTP boundaries; `src/components` holds the UI. Nodes and connections have independent rows and revisions. Position is saved at drag end, and semantic revisions exclude position-only edits. Failed stale saves leave form text intact for comparison and retry.

The live design exploration selected Compact workbench: all seven block types are visible at laptop height, while plain-language guidance stays in the detail panel. The temporary picker has been removed.

## Review and freeze

For live review, apply all migrations, then run `npm run worker` in a second terminal. The web app dispatches review IDs to the configured Temporal task queue; the worker reads the sealed draft from Supabase, calls OpenAI, and publishes validated findings. Keep both processes running for live demos; the fixture preview does not use a worker. Vercel may host the web/API, but the long-running Temporal worker needs a separate persistent process.

`Review & comments` opens anchored findings, replies, ordinary notes and review history. A missing desired outcome is clarified first. Review locks editing until it completes or is cancelled. Detail suggestions can be applied explicitly; graph changes remain manual. Freeze checks graph structure and requires one completed review and a decision on every finding. The resulting specification stays immutable. An engineer change request can lead to an explicitly opened new draft, with per-block customer approval and a fresh review before the next handoff.

The fixture reviewer is available only with all three flags: `MERIDIAN_REVIEW_PROVIDER=fixture`, `MERIDIAN_DATABASE=local`, and `MERIDIAN_LOCAL_DEMO=true`. It is for browser tests, is recorded as `fixture-reviewer`, and does not verify AI quality or Temporal. It cannot run against the configured remote database.

Additional verification, from `app/`:

```sh
npm run worker:check
npm run services:check -- --openai --temporal
npm run review:smoke -- --live
```

The first command bundles workflows without credentials and runs in CI. The OpenAI service check makes a paid probe outside the local inference ledger; the Temporal check only describes the namespace. The smoke command consumes live resources; the smoke command creates a clearly named synthetic workflow in Supabase and performs one bounded OpenAI review through Temporal. Start the worker first. No email is retrieved or sent by these checks.

## File map

| Location | Responsibility |
| --- | --- |
| `src/app/api/workflows` | Request validation and delegation; no orchestration or model prompts |
| `src/components/scoping`, `src/components/canvas`, `src/components/reviews`, `src/components/engineering`, `src/components/evaluations`, `src/components/repairs`, `src/components/runtime`, `src/components/grouped-execution` | Feature UI and browser state |
| `src/domain` | Typed contracts and pure graph/business rules; `errors.ts` and `validation.ts` hold cross-feature errors and scalar schemas; `repair-integrity.ts` checks for copied evaluation identifiers; `runtime-policy.ts` holds dependency-free activity liveness settings shared by workflows, workers and evaluation snapshots |
| `src/domain/evaluation-statistics.ts`, `src/server/evaluations/statistics.ts` | Read-only case/assertion counts against each locked suite; history queries omit actual outputs and traces |
| `src/components/evaluations/use-evaluation-data.ts` | Workspace loading, polling and historical suite/result projections; the panel owns selection and mutation actions |
| `src/components/evaluations/evaluation-results-header.tsx` | Evaluation history controls and result summary |
| `src/app/globals.css`, `src/styles` | Ordered global style imports, shared foundations and reduced-motion policy; canvas/review styles live with their features |
| `src/components/process-context`, `src/domain/process-context.ts`, `src/server/process-context` | Optional DeepShelves JSON import, selected evidence preview, bounded contracts and revision-checked persistence; review consumes observations, freeze retains them outside the executable graph |
| `src/server/canvas` | Targeted, revision-checked canvas mutations |
| `src/server/workflows/store.ts` | Shared workflow locking and graph reads |
| `src/server/scoping`, `src/domain/scoping.ts` | Persistent process notes, scoping operations, validated previews, atomic initial graph application and review obligations |
| `src/server/reviews` | Transactional review, discussion and freeze behavior |
| `src/server/reviews/reply-service.ts`, `src/server/reviews/reply-proposal-service.ts`, `src/server/integrations/openai-review-reply.ts` | Foreground answer proposals, per-block accept/reject decisions with editable wording, atomic revision-checked instruction saves and audit history |
| `src/components/reviews/conversation-message.tsx`, `src/components/reviews/instruction-diff.tsx`, `src/components/reviews/reply-changes.tsx`, `src/components/reviews/thread-card.tsx` | Conversation rendering, word diffs and a shared inline/expanded response flow |
| `src/server/process-revisions`, `src/components/process-revisions` | Engineer requests, explicit revision lifecycle and new unapproved handoff plans; existing review conversations own replies and per-block decisions |
| `src/server/engineering` | Versioned plans, generation lifecycle, project assembly and source/download inspection |
| `src/server/evaluations` | Verified suites, trusted grading, case execution and result history; `automatic-repair.ts` atomically hands an opted-in evaluation to one bounded repair session |
| `src/server/repairs` | Bounded sessions, candidate ancestry, diagnostic evidence projection and repeated-output field differences, bounded recorded-input replay, focused source patches, generation checkpoints and three-run confirmation |
| `src/server/inputs` | Prepare source-backed email packet suggestions; strict foreground capture and durable selected-email capture with per-source checkpoints into immutable input bundles |
| `src/server/grouped-execution` | Selected-email orchestration, immutable grouping/clarification evidence, child scopes, aggregation, shared budgets/capacity |
| `src/server/runtime` | Run/visit history, immutable interaction audit, run-scoped document access, isolated step contracts and human responses |
| `src/server/artifacts` | Immutable file records, integrity checks and local/private Supabase storage |
| `src/server/integrations` | Composio Gmail, OpenAI, Temporal, Vercel Sandbox and metered inference adapters |
| `src/server/database.ts`, `src/server/http.ts` | Database and HTTP infrastructure |
| `src/worker` | Temporal workflow definitions, activities and worker entry point |
| `migrations` | Ordered SQL migrations; existing applied migrations are not rewritten |
| `tests`, `tests/browser`, `tests/fixtures` | Business/persistence tests, browser journeys and sanitized fixtures |
| `scripts` | Explicit operator commands and live smoke checks |
| `scripts/demo` | Example process requirements, draft seeding and operator-supplied suite import |
| `../.runtime` | Ignored runtime databases, certificates, captured inputs and generated artifacts |
| `../work` | Ignored temporary verification renders and handoff-building tools; not application code |

ESLint rejects inward dependencies from domain to application layers, browser imports of server/worker code, and runtime I/O imports in deterministic workflow modules. Node built-ins are restricted in both bare and `node:` forms, including subpaths. Type-only workflow imports remain allowed.

Keep shared modules small and named for their responsibility. Split growing feature modules when another responsibility appears; do not add empty architectural folders or a catch-all utilities file.

## Implementation plans and generated projects

After freeze, open the engineer workspace, create a plan, request advisory method suggestions, approve each choice, and approve the plan. Generate agent starts a durable Temporal job; the app shows phase and cancellation while retaining existing versions. OpenAI writes coordinated Node 24 modules from the frozen spec and chosen methods. Complete source is retained even if its syntax check fails. Vercel Sandbox checks syntax with denied network egress; this is not a business evaluation. Inspect files and before/after source, download a ZIP, or create an explicit plan revision. Runtime services execute approved steps and locked evaluations; bounded repair is implemented and Gmail capture and manual run controls are available under Agent → Run workflow.

The worker reconciles queued jobs every five seconds using stable Temporal workflow IDs. Project bytes checkpoint generation across activity retries; SQL guards fence cancelled/expired publication. Each generation has at most two activity attempts, a 40-minute Temporal deadline and a 45-minute application expiry. Model generation is bounded to 15 minutes per activity; sandbox validation to one minute. The model defaults to `gpt-5.4-mini`, configurable with `OPENAI_ENGINEERING_MODEL`.

The fixture generator uses `MERIDIAN_ENGINEERING_PROVIDER=fixture` together with the same local-database/local-demo guards as review. Browser tests exercise approval, generation, source download and revision without spending live credits. Fixture validation never claims Sandbox verification.

Set `SUPABASE_SECRET_KEY` (or the legacy `SUPABASE_SERVICE_ROLE_KEY`) for private object storage, then run `npm run storage:setup`. The setup command creates or verifies a private bucket and refuses a public one. Without that key, development uses `../.runtime/artifacts`; production requires Supabase storage. Artifact rows record their storage backend and content hash so changing configuration never redirects an existing artifact to different bytes. When running another checkout against the same database, set `LOCAL_ARTIFACT_PATH` to the original absolute artifact directory for both the web app and worker. Otherwise existing local artifact records still exist but their files cannot be read. A missing file is an operational storage error, not a reason to repair generated business logic.

### Sandbox access

For Vercel Sandbox development, link the dedicated project with Vercel CLI and obtain its OIDC token through `vercel env pull` into a separate ignored file, then copy the needed token into `.env.local`. Do not overwrite the existing file or its other service settings. The current adapters rely on SDK OIDC discovery and do not pass an explicit access-token/team/project object. Merely setting `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` does not wire that alternative into this app. See [the adapter](src/server/integrations/sandbox-project.ts); never pass credentials to generated code. `npm run sandbox:smoke -- --live` creates a 30-second, nonpersistent sandbox with network egress denied, runs a small Node command, and always stops the sandbox. The selected Node image needs an explicit working directory; the adapter uses `/tmp/meridian`. Vercel project metadata stays in ignored `app/.vercel`. No application credentials are passed into the VM.

## Runtime verification

The [runtime guide](../docs/features/workflow-runtime.md) explains routing, human waits, limits, history and live recovery verification. Agent → Run workflow offers Selected emails for automatic grouped execution and Saved input for manual runs. The grouped inspector shows actual run/code provenance, clarification, human decisions, recovery history and partial reports. Generated code only executes inside Vercel Sandbox. The worker owns all scheduling, and SQL records progress without a second scheduler.

## Evaluation verification

The [evaluation guide](../docs/features/trusted-evaluations.md) describes authoring, verification, suite revisions and the results inspector. Apply all migrations and start a worker running the same application revision before evaluating. `npm run evaluation:smoke -- --live` creates a synthetic three-case suite and uses real Temporal child workflows and Vercel Sandbox. It expects one pass, one deliberate assertion failure, and one missing-human-fixture error: a completed, inconclusive evaluation. It does not verify Gmail or shipment accuracy.

Required CI includes suite locking/revision checks, full result coverage, late-attempt fencing, cancellation, fixed input ownership, and a browser journey that corrects expectations in a new suite while preserving earlier results. The guarded local fixture executor uses the engineering fixture flags; it never executes source and is labeled in the results view. Full live suites have a four-hour deadline in addition to per-case runtime limits. Expected values remain outside generated code's sandbox.

## Bounded repair

The [repair guide](../docs/features/bounded-repair.md) explains the three-attempt loop, baseline decisions and fixed scope. Choose Repair and rerun from an eligible evaluation; inspect candidates and their evaluations in Repair history. Suite corrections require explicit new verification and a fresh baseline evaluation. Runtime/model work stays on the Temporal worker, with generated execution isolated in Vercel Sandbox.

`npm run repair:smoke -- --live` is an optional synthetic live check using OpenAI, Temporal, Supabase and Sandbox. It consumes live resources and is separate from required CI fixtures. It does not retrieve or send email.

## Gmail capture

Set `COMPOSIO_API_KEY` and `COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID` for the existing read-only connection. The adapter resolves its connected-account user and pins the verified Gmail tool version. Only search, message fetch, and attachment fetch are exposed. It never sends mail or updates labels.

`GET /api/workflows/:id/gmail/messages?query=...` returns 25 messages per page. `POST /api/workflows/:id/gmail/capture` takes `message_ids` and `shipment_reference`, saving all attachments before publishing an input bundle. Capture is a bounded foreground request (four minutes), not another scheduler. This strict foreground route still requires every download to succeed. Selected-email runs instead use durable, checkpointed capture: four concurrent downloads, bounded per-source retries, explicit unavailable-attachment evidence, and progress retained across automatic worker retries. Apply migration `019_grouped_capture.sql` and deploy a matching worker before using that path. New top-level runs capture fresh inputs; they do not reuse another job’s checkpoints. See [capture behavior and limits](../docs/features/gmail-inputs.md).

```sh
npm run gmail:smoke -- --live --message <message-id> --shipment <reference> --pdf <invoice-filename>
```

This optional live check creates a workflow, captures one supplied message, and asks OpenAI to read the chosen PDF. It uses real mailbox data and credits; keep its output and captured artifacts private. Required CI uses sanitized fixtures for capture completeness, immutable inputs, run ownership, safe attachment downloads, and approved document interpretation. No live credentials are needed by CI.

Evidence-aware document extraction uses the pure `domain/extraction` contract, `server/runtime/extraction` for PDF page bounds, and `server/integrations/extraction-output.ts` for the schema-constrained provider envelope. Isolated evaluation cases can use the same immutable document bundles as workflow runs. Run the extraction/evaluation/Gmail fixture tests when changing this boundary.

## Inference spending guard

For bounded paid verification, set `INFERENCE_BUDGET_USD` and an absolute `INFERENCE_BUDGET_LEDGER` path in ignored local storage. Application OpenAI adapters share this ledger across local app/worker processes. The standalone `services:check -- --openai` probe uses the provider SDK directly and is not covered by this ledger. The guard supports `gpt-5.4`, `gpt-5.4-mini`, and their explicitly priced snapshots in `openai-client.ts`; configure review, scoping, engineering and runtime models to a supported name in both processes. The `.env.example` mini-model defaults are supported; unknown models or service tiers fail closed. This guard supports processes on one machine sharing a local filesystem; it is not a distributed or provider-enforced billing limit. Budgeted calls explicitly request standard service tier; response model, tier and usage must match the supported pricing before a reservation is settled. Reservations are flushed before dispatch and uncertain charges stay reserved. A stale `.lock` after a crashed writer requires operator inspection; the guard fails closed rather than discarding unknown spend. Keep the ledger when restarting an experiment. An invalid ledger or mismatched ceiling blocks new calls. Token preflight failures stop before inference; unknown request outcomes retain their reservations. Rates are recorded in `openai-client.ts` and must be checked before adding models. Pricing references: [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4) and [service tiers](https://developers.openai.com/api/reference/typescript/resources/responses).

`server/integrations/openai-preflight.ts` owns bounded read-only token-count recovery: at most three attempts for transient failures, with a 35-second per-attempt timeout inside the shared 120-second deadline. It never retries inference or skips a budget reservation. The policy is recorded in evaluation settings; restart idle workers after changing it, and start a new measurement sequence rather than combining results across policies.

`ReasoningDocument.source_page_numbers` preserves original page identities when a caller supplies a focused PDF subset. OpenAI document captions describe that mapping; this does not enable automatic reinspection or add another model call.

## Guided workflow scaffolding

On an empty draft, open the circular note button above the canvas zoom controls. Notes autosave; “Help build workflow” starts the explicit scoping interview. Confirm the scope to generate a connected preview, then apply the whole graph. Normal draft review is still mandatory before freeze. See the [feature contract](../docs/features/guided-workflow-scaffolding.md).

Apply migrations through `npm run db:migrate` and run the existing Temporal worker for durable live scoping. `OPENAI_SCOPING_MODEL` overrides the model (falls back to `OPENAI_REVIEW_MODEL`, then `gpt-5.4-mini`). For isolated fixture demos only, set `MERIDIAN_SCOPING_PROVIDER=fixture`, `MERIDIAN_DATABASE=local`, and `MERIDIAN_LOCAL_DEMO=true` together. This fixed scenario is not live process synthesis.

`npm run scoping:smoke` explicitly calls the live model with a sanitized request and an ephemeral database. It validates the interview, generated graph, human approval and review gate; it never reads a mailbox or applies to a saved workflow. Configure `OPENAI_API_KEY` and estimate inference spend before running it. The live check is separate from required fixture-based CI.


Evaluation scheduling uses `domain/runtime-policy.ts`: two concurrent cases per new suite evaluation and four activity slots per standard worker. Existing runs keep their recorded policy; see [trusted evaluations](../docs/features/trusted-evaluations.md#bounded-case-concurrency). Deploy web and workers consistently for new operations, and let existing workers drain their running operations before retiring them.

`domain/evaluation-recovery.ts` defines the narrow transient case-recovery policy. Evaluation services persist one recovery and its failed-run provenance (migration 016); the Temporal scheduler retries only that case. Apply migrations and deploy matching web/worker code after active operations drain.

`server/runtime/agent-interaction.ts` executes one audited Agent request. `invoke-step.ts` owns method checks, bounded extraction batches and generated postprocessing. The batch policy lives in `domain/extraction.ts`; migration 017 expands per-invocation audit capacity. Extraction field diagnostics are included in the bounded repair catalogue without changing locked grades.

The OpenAI integration keeps token preflight (`server/integrations/openai-preflight.ts`) separate from bounded response transport (`server/integrations/openai-response.ts`). Shared runtime deadline values live in `domain/runtime-policy.ts` and are recorded with evaluation settings.

`server/integrations/inference-trace.ts` collects safe provider-stage metrics per runtime interaction. They flow into immutable execution audit summaries and the repair evidence catalogue. `worker/execution-failure.ts` preserves trusted failure categories through Temporal wrappers.

## Run recovery

Migration 014 extends the shared repair lifecycle to failed manual runs. Apply it with the matching web app and worker deployed together; an older worker cannot execute run-origin repair jobs. The existing durable outbox queues automatic recovery after failure. Its default limits are recorded per session: three candidates, two hours of active work, and $5 reserved/recorded inference usage. The optional operator inference ledger remains an additional limit. GPT-5.4 and the app's default GPT-5.4 mini are priced for the standard endpoint; unsupported settings fail before paid inference. See the [recovery contract](../docs/features/bounded-repair.md#recovery-from-a-failed-manual-run) for acceptance, version selection and current limitations.

Engineer clarification lives in `domain/clarification.ts`, `server/repairs/clarification-service.ts` and `components/runtime/engineer-question.tsx`. Migration 015 persists questions, opt-in reuse and immutable invocation context. Deploy the matching worker and web code together; answered questions resume through durable worker polling without restarting budgets.


## Vercel hosting

An older worker may have frozen a workflow without setting the newer current-version pointer. Engineering can read its sole frozen snapshot while the workflow remains frozen; it does not rewrite the pointer or guess between multiple versions.

Deploy from `app/`; `vercel.json` selects Next.js and the Node runtime project setting should be 24.x. Configure the live-service variables above in Vercel. `SUPABASE_DB_SSL_CA` accepts the project CA PEM contents when a laptop certificate path is unavailable; certificate verification remains enabled. Keep Vercel deployment protection enabled and use its shareable-link feature for invited reviewers. There is no application role/auth system.

The Temporal worker remains a separate persistent process. It must share the database, queue and private artifact storage with the deployment. A web deployment alone does not run queued work. Do not copy the laptop's inference-ledger path into Vercel: that guard requires a shared local filesystem and does not enforce a distributed web/worker spending limit.

Existing local artifact rows can be served from verified copies in the private Supabase bucket without rewriting their identity or recorded results. After `npm run storage:setup`, run `npm run artifacts:mirror -- --source=/absolute/original/artifacts` from the configured laptop checkout. Repeat `--source=` for additional artifact roots. The command copies ready local files without overwrite and verifies remote length/hash against the immutable database record. Missing or mismatched files fail verification; records and source files stay unchanged. Enable `LOCAL_ARTIFACT_READ_BACKEND=supabase` only on the hosted app after copying. Artifact reads retain the existing ownership, readiness and hash checks. New hosted artifacts use Supabase normally.

If an existing local worker still writes local files, use `--watch` while it runs to mirror newly completed artifacts. Remote inspection may lag by a polling cycle. Prefer configuring shared private storage directly when the worker is next idle; do not restart active work merely to change storage. Deployment and artifact-mirror processes do not establish new evaluation passes.

## Deployment readiness

`npm run db:check` verifies both connectivity and every migration required by the current checkout. Remote app/worker startup also refuses an outdated schema with `SCHEMA_OUTDATED`; apply `npm run db:migrate` explicitly from the release being deployed. Migrations are included in the hosted server bundle for this check. A healthy database connection alone does not establish schema readiness.

Run web and worker from compatible releases with the same private artifact configuration. Restart an idle worker after changing credentials or storage settings; an already running process does not reload `.env.local`. Preserve active operations and inference ledgers. Historical local artifacts require the documented private mirror configuration on hosts without those files. The [demo readiness register](../docs/guides/demo-readiness.md) records observed failures and live retests.

- `src/server/gmail-drafts/`: workflow-specific draft opt-in, saved-result eligibility, and durable duplicate prevention for explicit Gmail draft actions. `src/components/gmail-drafts/` renders the action after an eligible run; evaluation and fixture execution cannot create drafts.
