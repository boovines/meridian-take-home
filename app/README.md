# Application

Next.js/React application for the Meridian take-home: process whiteboards, AI review, frozen handoff, generated agents, Gmail input capture, isolated execution, trusted evaluations and bounded repair. Start with the [documentation index](../docs/README.md). Measured verification and remaining limitations are tracked in [implementation status](../docs/implementation-status.md).

## Run locally

Use Node 24 and npm. From this directory:

```sh
npm ci
cp .env.example .env.local # only if you do not already have this file
npm run db:check
npm run db:migrate
npm run dev
```

The app opens at `http://127.0.0.1:3000`. Set the Supabase database fields in `.env.local`, including the password. For verified TLS, download the project CA from Supabase's Database Settings and set `SUPABASE_DB_SSL_ROOT_CERT` to its absolute file path. Alternatively set `DATABASE_URL` with `sslmode=verify-full` and `sslrootcert`. Never commit credentials. Migrations run explicitly for remote databases.

Each web or worker process opens at most four PostgreSQL connections. Transactions apply server-side limits of ten seconds per statement and thirty seconds idle, so a disconnected process cannot indefinitely hold a workflow lock. Broken connections are discarded, and a failed rollback preserves the original operation error. Supabase's transaction pooler can be selected with `SUPABASE_DB_PORT=6543`; `DATABASE_URL`, when supplied, takes precedence. Pool sizing still needs to account for the number of deployed processes.

To develop without a remote database, use `MERIDIAN_DATABASE=local npm run dev`. This stores a PGlite database in the ignored `../.runtime/database` directory and applies migrations automatically. This is a development fallback; it is not the production datastore. The service tests run against PostgreSQL in GitHub Actions.

The current server binds to localhost. Do not expose a hosted deployment without access protection; organization permissions are outside demo scope, but the demo must not expose shipment data or unrestricted writes publicly. Supabase REST access to the app tables is denied by RLS; all app queries use the server connection.

## Verify changes

```sh
npm run docs:check
npm run lint
npm run typecheck
npm test
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

Apply migrations, then run `npm run worker` in a second terminal. The web app dispatches review IDs to the configured Temporal task queue; the worker reads the sealed draft from Supabase, calls OpenAI, and publishes validated findings. Keep both processes running for local demos. Vercel may host the web/API, but the long-running Temporal worker needs a separate persistent process.

`Review & comments` opens anchored findings, replies, ordinary notes and review history. A missing desired outcome is clarified first. Review locks editing until it completes or is cancelled. Detail suggestions can be applied explicitly; graph changes remain manual. Freeze checks graph structure and requires one completed review and a decision on every finding. The resulting board cannot be edited in this demo.

The fixture reviewer is available only with all three flags: `MERIDIAN_REVIEW_PROVIDER=fixture`, `MERIDIAN_DATABASE=local`, and `MERIDIAN_LOCAL_DEMO=true`. It is for browser tests, is recorded as `fixture-reviewer`, and does not verify AI quality or Temporal. It cannot run against the configured remote database.

Additional verification, from `app/`:

```sh
npm run worker:check
npm run services:check -- --openai --temporal
npm run review:smoke -- --live
```

The first command bundles workflows without credentials and runs in CI. The last two consume live service resources; the smoke command creates a clearly named synthetic workflow in Supabase and performs one bounded OpenAI review through Temporal. Start the worker first. No email is retrieved or sent by these checks.

## File map

| Location | Responsibility |
| --- | --- |
| `src/app/api/workflows` | Request validation and delegation; no orchestration or model prompts |
| `src/components/canvas`, `src/components/reviews`, `src/components/engineering`, `src/components/evaluations`, `src/components/repairs`, `src/components/runtime` | Feature UI and browser state |
| `src/domain` | Typed contracts and pure graph/business rules; `errors.ts` and `validation.ts` hold cross-feature errors and scalar schemas; `repair-integrity.ts` checks for copied evaluation identifiers |
| `src/components/evaluations/use-evaluation-data.ts` | Workspace loading, polling and historical suite/result projections; the panel owns selection and mutation actions |
| `src/components/evaluations/evaluation-results-header.tsx` | Evaluation history controls and result summary |
| `src/app/globals.css`, `src/styles` | Ordered global style imports, shared foundations and reduced-motion policy; canvas/review styles live with their features |
| `src/server/canvas` | Targeted, revision-checked canvas mutations |
| `src/server/workflows/store.ts` | Shared workflow locking and graph reads |
| `src/server/reviews` | Transactional review, discussion and freeze behavior |
| `src/server/engineering` | Versioned plans, generation lifecycle, project assembly and source/download inspection |
| `src/server/evaluations` | Verified suites, trusted grading, case execution and result history |
| `src/server/repairs` | Bounded sessions, candidate ancestry, diagnostic evidence projection and repeated-output field differences, bounded recorded-input replay, focused source patches, generation checkpoints and three-run confirmation |
| `src/server/inputs` | Capture existing Gmail messages and attachment evidence into immutable input bundles |
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

 Set `SUPABASE_SECRET_KEY` (or the legacy `SUPABASE_SERVICE_ROLE_KEY`) for private object storage, then run `npm run storage:setup`. The setup command creates or verifies a private bucket and refuses a public one. Without that key, development uses `../.runtime/artifacts`; production requires Supabase storage. Artifact rows record their storage backend and content hash so changing configuration never redirects an existing artifact to different bytes.

For Vercel Sandbox development, link the dedicated project with Vercel CLI and obtain its OIDC token through `vercel env pull`. Preserve other local secrets when refreshing that token. `npm run sandbox:smoke -- --live` creates a 30-second, nonpersistent sandbox with network egress denied, runs a small Node command, and always stops the sandbox. The selected Node image needs an explicit working directory; the adapter uses `/tmp/meridian`. Vercel project metadata stays in ignored `app/.vercel`. No application credentials are passed into the VM.

## Runtime verification

The [runtime guide](../docs/features/workflow-runtime.md) explains routing, human waits, limits, history and live recovery verification. Manual run controls and Gmail capture are available under Agent → Run workflow. Generated code only executes inside Vercel Sandbox. The worker owns all scheduling, and SQL records progress without a second scheduler.

## Evaluation verification

The [evaluation guide](../docs/features/trusted-evaluations.md) describes authoring, verification, suite revisions and the results inspector. Apply migration 008 and restart the worker before evaluating. `npm run evaluation:smoke -- --live` creates a synthetic three-case suite and uses real Temporal child workflows and Vercel Sandbox. It expects one pass, one deliberate assertion failure, and one missing-human-fixture error: a completed, inconclusive evaluation. It does not verify Gmail or shipment accuracy.

Required CI includes suite locking/revision checks, full result coverage, late-attempt fencing, cancellation, fixed input ownership, and a browser journey that corrects expectations in a new suite while preserving earlier results. The guarded local fixture executor uses the engineering fixture flags; it never executes source and is labeled in the results view. Full live suites have a four-hour deadline in addition to per-case runtime limits. Expected values remain outside generated code's sandbox.

## Bounded repair

The [repair guide](../docs/features/bounded-repair.md) explains the three-attempt loop, baseline decisions and fixed scope. Choose Repair and rerun from an eligible evaluation; inspect candidates and their evaluations in Repair history. Suite corrections require explicit new verification and a fresh baseline evaluation. Runtime/model work stays on the Temporal worker, with generated execution isolated in Vercel Sandbox.

`npm run repair:smoke -- --live` is an optional synthetic live check using OpenAI, Temporal, Supabase and Sandbox. It consumes live resources and is separate from required CI fixtures. It does not retrieve or send email.

## Gmail capture

Set `COMPOSIO_API_KEY` and `COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID` for the existing read-only connection. The adapter resolves its connected-account user and pins the verified Gmail tool version. Only search, message fetch, and attachment fetch are exposed. It never sends mail or updates labels.

`GET /api/workflows/:id/gmail/messages?query=...` returns 25 messages per page. `POST /api/workflows/:id/gmail/capture` takes `message_ids` and `shipment_reference`, saving all attachments before publishing an input bundle. Capture is a bounded foreground request (four minutes), not another scheduler. Large packets may require a future durable capture job; a failed capture does not become runnable. See [capture behavior and limits](../docs/features/gmail-inputs.md).

```sh
npm run gmail:smoke -- --live --message <message-id> --shipment <reference> --pdf <invoice-filename>
```

This optional live check creates a workflow, captures one supplied message, and asks OpenAI to read the chosen PDF. It uses real mailbox data and credits; keep its output and captured artifacts private. Required CI uses sanitized fixtures for capture completeness, immutable inputs, run ownership, safe attachment downloads, and approved document interpretation. No live credentials are needed by CI.

Evidence-aware document extraction uses the pure `domain/extraction` contract, `server/runtime/extraction` for PDF page bounds, and provider code in `server/integrations`. Isolated evaluation cases can use the same immutable document bundles as workflow runs (migration 011). Run the extraction/evaluation/Gmail fixture tests when changing this boundary.

For bounded paid verification, set `INFERENCE_BUDGET_USD` and an absolute `INFERENCE_BUDGET_LEDGER` path in ignored local storage. All OpenAI adapters share this ledger across local app/worker processes. The guard currently supports `gpt-5.4` or its `gpt-5.4-2026-03-05` snapshot; configure review, engineering and runtime models consistently. This guard supports processes on one machine sharing a local filesystem; it is not a distributed or provider-enforced billing limit. Budgeted calls explicitly request standard service tier; response model, tier and usage must match the supported pricing before a reservation is settled. Reservations are flushed before dispatch and uncertain charges stay reserved. A stale `.lock` after a crashed writer requires operator inspection; the guard fails closed rather than discarding unknown spend. Keep the ledger when restarting an experiment. An invalid ledger or mismatched ceiling blocks new calls. Token preflight failures stop before inference; unknown request outcomes retain their reservations. Rates are recorded in `openai-client.ts` and must be checked before adding models. Pricing references: [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4) and [service tiers](https://developers.openai.com/api/reference/typescript/resources/responses).

`server/integrations/openai-preflight.ts` owns bounded read-only token-count recovery: at most three attempts for transient failures, honoring cancellation and a shared deadline. It never retries inference or skips a budget reservation. The policy is recorded in evaluation settings; restart idle workers after changing it, and start a new measurement sequence rather than combining results across policies.

`ReasoningDocument.source_page_numbers` preserves original page identities when a caller supplies a focused PDF subset. OpenAI document captions describe that mapping; this does not enable automatic reinspection or add another model call.
