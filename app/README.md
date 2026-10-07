# Application

Next.js/React application for the Meridian take-home. The app supports persisted process whiteboards, AI review and frozen handoff. Generation and execution progress is tracked in `../docs/implementation-status.md`.

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

To develop without a remote database, use `MERIDIAN_DATABASE=local npm run dev`. This stores a PGlite database in the ignored `../.runtime/database` directory and applies migrations automatically. This is a development fallback; it is not the production datastore. The service tests run against PostgreSQL in GitHub Actions.

The current server binds to localhost. Do not expose a hosted deployment without access protection; organization permissions are outside demo scope, but the demo must not expose shipment data or unrestricted writes publicly. Supabase REST access to the app tables is denied by RLS; all app queries use the server connection.

## Verify changes

```sh
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

`npm test` uses an in-memory PGlite database by default. To exercise PostgreSQL locally, point `TEST_DATABASE_URL` at an isolated localhost database. The tests reject remote database hosts. Browser tests start a production server on port 3101 with a separate local database in `../.runtime/browser-tests`; they never use `.env.local`'s Supabase connection. Live service checks are separate from these fixture tests.

CI runs lint, typecheck, production build, service/domain tests against PostgreSQL 17, and browser journeys for persistence and stale-edit recovery. It needs no Gmail or model credentials.

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
| `src/components/canvas`, `src/components/reviews`, `src/components/engineering` | Feature UI and browser state |
| `src/domain` | Typed contracts and pure graph/business rules |
| `src/server/canvas` | Targeted, revision-checked canvas mutations |
| `src/server/workflows/store.ts` | Shared workflow locking and graph reads |
| `src/server/reviews` | Transactional review, discussion and freeze behavior |
| `src/server/engineering` | Versioned plans, generation lifecycle, project assembly and source/download inspection |
| `src/server/artifacts` | Immutable file records, integrity checks and local/private Supabase storage |
| `src/server/integrations` | OpenAI, Temporal and Vercel Sandbox adapters |
| `src/server/database.ts`, `src/server/http.ts` | Database and HTTP infrastructure |
| `src/worker` | Temporal workflow definitions, activities and worker entry point |
| `migrations` | Ordered SQL migrations; existing applied migrations are not rewritten |
| `tests`, `tests/browser`, `tests/fixtures` | Business/persistence tests, browser journeys and sanitized fixtures |
| `scripts` | Explicit operator commands and live smoke checks |
| `../.runtime` | Ignored runtime databases, certificates and future generated projects |

Keep shared modules small and named for their responsibility. Split growing feature modules when another responsibility appears; do not add empty architectural folders or a catch-all utilities file.

## Implementation plans and generated projects

After freeze, open the engineer workspace, create a plan, request advisory method suggestions, approve each choice, and approve the plan. Generate agent starts a durable Temporal job; the app shows phase and cancellation while retaining existing versions. OpenAI writes coordinated Node 24 modules from the frozen spec and chosen methods. Complete source is retained even if its syntax check fails. Vercel Sandbox checks syntax with denied network egress; this is not a business evaluation. Inspect files and before/after source, download a ZIP, or create an explicit plan revision. Evaluation, repair and full runtime are the next feature.

The worker reconciles queued jobs every five seconds using stable Temporal workflow IDs. Project bytes checkpoint generation across activity retries; SQL guards fence cancelled/expired publication. Each generation has at most two activity attempts, a 40-minute Temporal deadline and a 45-minute application expiry. Model generation is bounded to 15 minutes per activity; sandbox validation to one minute. The model defaults to `gpt-5.4-mini`, configurable with `OPENAI_ENGINEERING_MODEL`.

The fixture generator uses `MERIDIAN_ENGINEERING_PROVIDER=fixture` together with the same local-database/local-demo guards as review. Browser tests exercise approval, generation, source download and revision without spending live credits. Fixture validation never claims Sandbox verification.

 Set `SUPABASE_SECRET_KEY` (or the legacy `SUPABASE_SERVICE_ROLE_KEY`) for private object storage, then run `npm run storage:setup`. The setup command creates or verifies a private bucket and refuses a public one. Without that key, development uses `../.runtime/artifacts`; production requires Supabase storage. Artifact rows record their storage backend and content hash so changing configuration never redirects an existing artifact to different bytes.

For Vercel Sandbox development, link the dedicated project with Vercel CLI and obtain its OIDC token through `vercel env pull`. Preserve other local secrets when refreshing that token. `npm run sandbox:smoke -- --live` creates a 30-second, nonpersistent sandbox with network egress denied, runs a small Node command, and always stops the sandbox. The selected Node image needs an explicit working directory; the adapter uses `/tmp/meridian`. Vercel project metadata stays in ignored `app/.vercel`. No application credentials are passed into the VM.
