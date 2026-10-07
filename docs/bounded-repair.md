# Bounded repair

From a completed evaluation with implementation failures, the engineer chooses **Repair and rerun**. A session fixes its approved plan, locked suite, starting code and starting evaluation. It generates at most three candidates. Each candidate gets a full evaluation before any acceptance decision; partial or inconclusive evidence never establishes an accepted baseline.

Acceptance compares individual assertion identities within the same suite. Every previously passing assertion must still pass. A candidate that preserves those passes can become the next baseline even if other assertions still fail; a regressing candidate remains in history and the next attempt starts from the retained baseline. Later attempts receive earlier candidates' failed assertions and execution errors as evidence, without adopting rejected source as the baseline. All verified assertions passing ends the session. Three attempts, a required engineer decision, or the fixed two-hour operation limit ends it with an explicit status. Another session requires a new engineer action.

Repair can change step implementation and Agent prompts within approved methods. The platform reassembles the frozen graph, plan, launcher and human gates. The model cannot rewrite expectations, change methods, remove human approval, schedule its own workflow or send reports. It can return `needs_attention` when the approved scope cannot support a fix. Input, infrastructure and unclassified evaluation failures require investigation before starting repair. A syntax/build failure attributable to implementation is repairable.

## Persistence and execution

Migration 009 adds `repair_sessions` and `repair_attempts`. A session points to the initial evidence and current accepted baseline; each attempt points to its own starting baseline, candidate and evaluation. Candidate source, completed evaluations, and finished attempts/sessions are immutable. Same-workflow foreign keys and SQL guards constrain plan, suite, parent-code and candidate-evaluation identity. The service computes acceptance against trusted grades; the model's diagnosis is explanatory only.

One workflow job owns the entire repair session, including candidate evaluations and their workflow executions. Temporal owns the sequence, retries, cancellation and deadline timer. Short database transactions take the existing workflow lock; model and sandbox calls run outside transactions. An invocation token fences late generation responses, with two infrastructure invocations permitted for one attempt. A complete artifact checkpoints publication recovery without regenerating code. Cancellation atomically closes unfinished evaluation projections and preserves terminal evidence.

A new suite revision requests cancellation of active repair. New repair sessions reject older suites: the engineer must verify/lock the revised suite and evaluate the chosen baseline against it first. Candidate builds are checked and generated code is executed only inside Vercel Sandbox, without network egress or application secrets. Report delivery is outside scope.

Repair receives the complete document metadata inventory for the locked suite's captured inputs, separately from bounded trace-output previews. This lets it identify selection mistakes involving numeric or ambiguous filenames without copying email bodies into the inventory. Exact source, requirements, assertions, grades and inventory must fit the context budget; oversized required context stops for inspection rather than silently dropping evidence. Passing a finite suite does not prove every business rule: independent counterexamples and source inspection can require a new suite revision.

## Interface

Evaluation keeps its existing case/result inspector. Repair history adds a baseline sidebar and chronological attempts with acceptance reasons, diagnosis, changes, evaluation links and direct code inspection. The three explored layouts were Attempt ledger, Candidate cards and Baseline sidebar. Baseline sidebar was selected because it distinguishes retained code from candidate history without requiring the engineer to reconstruct the chain. All picker scaffolding was removed.

## Verification

Required service tests cover regression rejection, candidate ancestry, complete suite identity, three-attempt exhaustion, deliberate restart, superseded publication, durable artifact recovery, cancellation, suite revision and operational-error rejection. The existing browser journey also starts a fixture repair, inspects its three retained attempts and code, checks the narrow layout, then revises a suite while preserving older results. These run through existing GitHub Actions commands. The fixture adapter does not execute generated source or establish model quality.

For a separate live check, start the worker and run `npm run repair:smoke -- --live` from `app/`. It creates a synthetic workflow with explicit counting requirements and deliberately faulty code, verifies three cases, runs an actual baseline evaluation, and requests actual OpenAI repair through Temporal and Vercel Sandbox.

On October 7 the live workflow `9624637b-bb82-48e2-99eb-7fb242af83cf` produced a failed baseline (`3343a611-cfee-4224-916f-8031e96f8639`, 2/3 cases passing). Session `c41fc32b-ae5c-4450-8f26-76f6119fadcd` repaired the failed-good count in one attempt. Evaluation `334ea8fa-3422-4133-b220-176ad3d51e96` passed all three cases and promoted code v3. This verifies synthetic repair, not Gmail ingestion, PDF extraction or the supplied shipment ground truth.
