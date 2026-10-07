# Application

Next.js/React application for the Meridian take-home. The current feature is a persisted process whiteboard; review, freeze, generation and execution are tracked in `../docs/implementation-status.md`.

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
