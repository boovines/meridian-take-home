# Demo readiness audit — October 9, 2026

This is an active failure register, not a readiness certification. Reported symptoms are kept separate from reproduced failures and confirmed causes. No fixes had been made when this register was opened.

## Baselines and scope

- Local isolated checkout: `1a57ff3`, branch `codex/demo-readiness`, stacked on `codex/vercel-hosting` (PR 86). Initial checks at `4a48f60` are historical only.
- Existing uncommitted freeze/method-suggestion changes remain in the original checkout and are not part of this initial baseline.
- Original production deployment: `dpl_3auMhztd84b3JzwCNwnPqR5jFPzE`, alias <https://meridian-take-home.vercel.app>, created October 9 at 17:26 EDT.
- The original worker ran from `79ab206`. It was replaced only after checking for idle operations; the current worker runs the repaired checkout with private artifact storage configured.
- Required coverage: authoring/save/reopen, review/reply/freeze, method approval/generation/source, input capture, execution/human response/report/audit, evaluations and bounded repair; errors, reloads and interrupted requests.
- Fixture tests and live provider checks are separate evidence. Existing exposed cases are regression coverage, never held-out validation.

## Failure register

| ID | Symptom | Evidence/status | Cause | Repair/verification |
| --- | --- | --- | --- | --- |
| DEMO-001 | Order entry did not progress | Live retry now completed | Prior individual failures lack diagnostics; current cap/schema blockers confirmed separately | Original review completed; synthetic order implementation passed 2 full evaluations |
| DEMO-002 | Wi-Fi interruption disrupted walkthrough | Network event reported; read recovery reproduced | Trace/audit/source lacked retry behavior | Read recovery fixed and browser-tested; physical Wi-Fi reliability is external |
| DEMO-003 | Review unreliable live | Generic failures confirmed in saved history | Confirmed current provider cap; missing schema also prevented current board reads | Cap raised by owner, migration applied, safe error persistence added; live review passed |
| DEMO-004 | Agent generation unreliable | Recent jobs show local inference-budget exhaustion | Local experiment ceiling is separate from provider project cap | Preserved old ledger; capped verification ledger and current worker; live generation passed |
| DEMO-005 | Execution/audit failed to display | Interrupted audit/trace loads reproduced | No retry, sticky errors; overlapping event reads cancelled each other | Independent event requests, explicit retries and scoped state; browser-tested |
| DEMO-006 | Business logic loses context when translated into executable contracts | Broader accuracy concern; no universal fix claimed | Requires per-workflow trace evidence | Fixed synthetic order suite passed twice; live bounded repair passed 3 confirmations; real shipment retest blocked by provider cap (5 passed, 3 errors, 16 not run) |
| DEMO-007 | Review/method recommendations hide provider limits | Reproduced at real adapter and activity seams | Missing safe model-output classification and durable specific error | Regression tests pass |
| DEMO-008 | Audit list remains loading after failed read | Browser-reproduced | No retry dependency/control | Fixed; interrupted list and payload plus overlapping reads pass |
| DEMO-009 | Fresh runtime cannot load generated artifact | Live synthetic run failed `ARTIFACT_UNAVAILABLE` | Old worker/configuration inconsistent with current private artifact access | Restarted idle worker with current storage config; new runtime completed |
| DEMO-010 | Current board/scoping operations fail on missing table | Live SQLSTATE `42P01` | Migration 018 absent | Applied migration; added startup/CLI schema gate and bundle tracing |
| DEMO-011 | Source-viewer error plus perpetual loading and incorrect evaluation label | Screenshot; intermittent error reproduced with HTTP failure | Recovery/status bug confirmed; original transient read cause unknown | Retry and truthful evidence labels fixed; historical v17 API and UI also loaded successfully |
| DEMO-012 | Scoping emits conditioned Otherwise path | Live preview rejected by existing validator | Provider schema allowed an invalid routing combination | Provider `anyOf` contract tightened; live scoping retest passed |
| DEMO-013 | Trace error cannot recover in place | Interrupted completed-run read | Missing retry and scoped state | Explicit retry; recovery journey passed |

## Verification log

A deployment status of Ready does not establish application readiness. The evidence below distinguishes fixture checks, live integration checks and business-accuracy measurements.

## Observations before repairs

- OpenAI Responses API returned HTTP 429 with `type=insufficient_quota`, `code=project_spend_limit_exceeded`. This is a confirmed current external blocker; no billing setting has been changed. Six historical order-entry reviews failed in roughly 1–3 seconds with a generic retry message; their saved records do not establish each original cause.
- Database connectivity, Temporal namespace connectivity and real Sandbox execution passed. The first Sandbox invocation in the new worktree lacked project metadata; copying the existing ignored link resolved that test setup issue.
- DEMO-007: Review and method suggestions bypass the existing safe provider-error classifier. Reproducing with the observed project-cap response at both actual adapter call sites; repair pending.
- DEMO-008: Audit initial-load failure leaves a perpetual loading state and no retry control. Interrupted-request browser regression added before repair; execution pending.
- DEMO-009: Fresh live synthetic runtime failed at its first step. Captured run `6b76bad6-9bbd-46fe-a9cb-b420136aa293`; investigation pending. No business expectations were changed.
- Initial old-checkout checks: 204 tests passed, one skipped; 16 browser journeys passed; lint, typecheck, docs, build and worker bundle passed. These do not establish current-deployment or live-provider correctness.

### Confirmed schema/configuration failures

- DEMO-010 (high): Current code's `readBoard` queries `workflow_process_context`, but the live schema has no such relation and lacks `018_process_context.sql`. Current live runtime setup reproduced SQLSTATE `42P01`; deployed scoping requests also returned 500. This is a confirmed missing migration, not merely a hypothesis. The migration is additive (one table, RLS and frozen-state guard); apply it before retrying live flows.
- DEMO-009 localization: The first synthetic project was successfully written/read in private Supabase storage, while the old worker reported `ARTIFACT_UNAVAILABLE`. All operations were idle before restarting the worker from `1a57ff3` with current storage configuration. Fresh retest next stopped at DEMO-010 before execution; do not yet claim artifact execution recovered.
- DEMO-011: User screenshot shows v17 source loading error and misleading “Not yet evaluated” while source is unavailable. Current API and local `VersionService.inspect` both succeed, including parent and evaluation evidence; original transient cause unconfirmed. Add recovery and accurate loading/error labels, preserving immutable source.
- After the user raised the OpenAI project cap, a new structured generation succeeded. The older local experiment ledger was nearly exhausted (124.927928 of 125 USD); verification now uses a separate capped 10 USD ledger, preserving prior evidence.
- New regressions reproduced DEMO-007 at both provider adapter call sites, its activity persistence gap, and DEMO-008 in the real runtime browser journey. No implementation fixes had been applied at this checkpoint.

- DEMO-012: Live scoping preview failed `INVALID_SCAFFOLD: Otherwise paths cannot also have a condition.` The prompt already disallows this, but its structured-output schema accepts the invalid combination. Tighten the provider contract while keeping graph validation and confirmed requirements unchanged.
- Migration 018 applied successfully. Original order-entry review `ab280fb8-81a0-48a2-ab8b-793e3598c182` completed. Fresh runtime `ebacf4f4-6e59-438c-82c2-d67d3fe89a02` completed 3 steps and one human response after restart/migration. Synthetic evaluation `cbf7c030-a167-4e71-8242-0c88cfb27d18` correctly completed inconclusive with one pass, one assertion failure and one missing-human-fixture error.

- DEMO-013: Interrupted execution-trace request has no retry control and retains error state. Reproduced in the runtime journey; add scoped retry and reset state when inspecting a different run.

## Repair evidence

- `npm run db:migrate`: applied missing migration 018 on the live database. Added schema readiness checks to remote app/worker startup and `db:check`, with a regression for missing migrations.
- Review and recommendation adapter regressions now pass, including safe durable review errors.
- Source, trace, audit-list and audit-payload interruptions now recover through explicit retry. Browser coverage includes overlapping audit reads, narrow-screen report inspection and source status truthfulness.
- Live Gmail search through the production API returned HTTP 200 and 15 messages; message contents are not included here. This search check alone does not prove capture completeness.
- Live order-entry generation produced version `45c84e2e-8b59-4acf-a29e-44f2b2f98f29` on synthetic workflow `12db771b-7a01-4d53-abe0-10c807bd3e3e`. Two full evaluations of the same artifact and locked four-case suite passed (`bb0f1e20-59b6-4f4d-8611-b3b7072ce4a9`, `93d746ab-bb02-4293-bbd9-d5ab349284da`). Cases check explicit order extraction, repeated-SKU line preservation/summing, missing quantity and non-order classification. Expectations were authored before generation and never modified. This uses synthetic text and is not PDF or held-out accuracy evidence. Plan/review setup for this synthetic case was fixture-driven; the separate original order-entry review was live.
- Live repair session `457740b3-34e8-4107-8909-0a4fd8280663` repaired the intentional failed-good counting bug in one accepted attempt and completed three consecutive full-suite confirmation passes with fixed expectations. This demonstrates the bounded repair path on its exposed synthetic regression suite, not general business-logic accuracy.
- Scoping schema repair initially used a discriminated union rejected by OpenAI as unsupported `oneOf`; switched to supported `anyOf` with mutually exclusive literal flags. Provider compatibility is being retested live, not inferred from local JSON-schema serialization.

- Final live scoping retest passed: 9 paths, a preserved human-approval loop, an explicit unresolved retention question, and normal review still required.
- Live Gmail capture completed into a private synthetic test workflow (`0beab52e-ea58-4a14-8960-59b7660b1719`); no message was sent or modified. Captured content remains in private artifact storage.
- Historical v17's latest prior evaluation had 15 `INFERENCE_BUDGET_LIMIT` and one `BUDGET_UNAVAILABLE` case, explaining its inconclusive result. Fresh 24-case evaluation `7bcb13f3-7559-44db-bfba-9e321a44043c` used unchanged code, locked expectations and disabled automatic repair. Five cases passed, three returned `MODEL_PROJECT_SPEND_LIMIT`, and the remaining sixteen were not run after cancelling this verification job. The result is inconclusive; no business-rule defect or full PDF accuracy pass can be inferred from the unexecuted cases. Small text requests succeeding does not establish that the project can fund larger PDF requests.

## Current verification result

- Local suite: 446 tests passed, one PostgreSQL-only test skipped because no local `TEST_DATABASE_URL` was available. PostgreSQL CI passed all 447 tests across 58 files on implementation commit `76cc2c3`; every required application check passed.
- Browser suite: all 38 journeys passed, including failed-read recovery and concurrent audit disclosure requests.
- Lint, typecheck, production build, worker bundle, documentation links and diff hygiene passed.
- Verified production build: <https://meridian-take-home-ouscp2qu3-justin-hous-projects.vercel.app>. Authenticated hosted requests returned HTTP 200 for the original order-entry board, synthetic generated source with passed evaluation evidence, completed execution trace, audit list and private audit payload. This also verifies the deployment contains the migration files required by startup checks.
- Repair PR: <https://github.com/boovines/meridian-take-home/pull/88>, stacked on PR 86 and left open.
- Remaining external blocker: larger PDF calls still receive the provider's enforced project-spend-limit error after the owner raised a limit. The separate application verification budget is not exhausted. A complete unchanged 24-case suite must pass before calling that real-document demo verified. Do not lower expectations or present partial execution as a pass.

- Promoted verified deployment `dpl_HMpTCukwprGLjoQBqTJANqYkYMkZ` to <https://meridian-take-home.vercel.app>. The browser confirmed current source files and “Passed · Suite V1” on the synthetic order workflow after promotion. No PR was merged.
- The repaired local server is running at <http://127.0.0.1:3217> against the live services; its source viewer also loaded the same passed evaluation. An existing unrelated server on port 3107 still serves older UI and was left untouched. Use the repaired checkout/server when validating these changes.
