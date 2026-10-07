# Workflow execution

The trusted runtime runs the frozen graph against one immutable input bundle and code version. Its API creates a durable operation, exposes ordered step history, accepts a human response, and permits cancellation. Run controls in the engineer UI and Gmail capture are the next integration work; this feature is currently exercised through services/API and the live smoke command.

Temporal owns scheduling, parallel joins, active-time timers, and human waits. Postgres stores application progress and history. Each visit has a scheduling key and per-node visit number; a retry within that visit uses a fresh fencing token. Completed outputs are reused on duplicate delivery. An obsolete invocation cannot overwrite a completed, cancelled, or superseded attempt.

The server obtains a human response before invoking a Human implementation. Agent implementations may request one bounded OpenAI interpretation, then must complete. Code implementations cannot request tools. Vercel Sandbox runs each invocation in a fresh Node 24 VM with denied network access, no application credentials, a 20-second process timeout and bounded output. The server checks output shape and outgoing routes; the candidate cannot schedule arbitrary nodes.

An exclusive split requires exactly one matching route, or its Otherwise fallback on zero matches. Each parallel branch sees the shared split context plus its own path outputs until the merge. A parallel split starts its declared branches, waits for the paired merge, and creates a separate join on every visit. A failed branch stops new downstream work; already-running siblings may finish for diagnosis. Overlapping and nested parallel sections are rejected at freeze.

Runs record fixed limits of 100 scheduled attempts and 900 active seconds. Infrastructure redelivery can invoke a visit at most twice and consumes an additional attempt. Active time includes automated work and backoff across parallel branches, without summing their durations. It pauses only when all remaining paths await a human. Exceeding a limit needs attention; it is never successful completion. A fresh retry retains the same code and captured inputs, links to the old run, and carries no previous approvals.

## Verify

From `app/`, run `npm test` and `npm run worker:check`. These are in CI and do not need provider credentials. Runtime tests cover route ambiguity, Otherwise, fresh human visits, per-occurrence joins, parallel failure, active-time accounting, immutable history, duplicate delivery, ownership, and late-result fencing.

With configured Supabase, Temporal, and Vercel Sandbox, apply migrations and start the worker. `npm run runtime:smoke -- --live --leave-waiting` creates a clearly synthetic three-step workflow using deterministic fixture source, executes it in Sandbox, and reports the waiting run ID. Stop the worker, run `npm run runtime:smoke -- --live --resume <run-id>`, then restart the worker. The response is persisted while offline and delivered from the outbox; the command verifies completion. This smoke check does not call the generator, retrieve Gmail, or send email.

Live verification on October 7: run `8f8debcc-95ce-4baa-a2f6-ec0b73de3111` completed all three steps after worker restart, with one persisted approval. The run is synthetic and is not shipment-accuracy evidence.
