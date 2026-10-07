# Import-receiving walkthrough

The demo uses the same whiteboard, generation, runtime and evaluation services as any saved workflow. Import-receiving rules live in the example requirements; the platform does not hardcode shipment results.

## Prepare

Follow [app setup](../../app/README.md). Start the web app and the Temporal worker in separate terminals. Use the configured Supabase database, OpenAI project, read-only Composio Gmail connection, and Vercel Sandbox project. Keep source documents and expected-answer manifests in ignored local storage. A local demo can use local artifacts; hosting needs the configured private Supabase storage and access protection.

From `app/`, `npm run demo:seed -- --create --incomplete` creates an intentionally incomplete five-block draft. Omit `--incomplete` to start with the full example requirements. Each invocation creates a new workflow and prints its path. It does not review, freeze, capture mail, or execute anything automatically.

## Process-owner walkthrough

1. Open the draft. Explain the desired outcome, then the two parallel extraction branches and their paired merge.
2. Request AI review. Select an anchored finding, answer it, and update the relevant requirements. Detail changes offer **Apply and resolve**; graph changes remain manual. Close rejected suggestions with a reason.
3. Review the revised draft again. The assignment demonstration requires two rounds. The product's minimum freeze rule is one completed review, resolved findings and a valid structure.
4. Freeze and hand off. Show the recorded review decisions and locked board. Later changes require another workflow in this demo.

The complete example requirements are in `app/scripts/demo/import-receiving.ts`. They distinguish invoice field failures from missing batch certificates. A good missing two fields is one failed good with two details; a failed batch does not by itself increase failed-invoice or failed-good totals.

The clarified example accepts a packaging-to-manufacturing batch relationship when the documents corroborate the same product, strength and manufacturer. Original identifiers and supporting evidence remain visible; a shared prefix or a CoC without an actual CoA is insufficient. These are customer requirements for the example. The harness generates and repairs the workflow's implementation; the shared runtime and grader contain no invoice-specific matching algorithm. Independently reviewed source observations and expected results belong in the workflow's locked evaluation suite, not in generated answers or platform conditionals.

If a customer clarifies requirements after freeze, create a new workflow for this demo and preserve the earlier frozen process and evaluations. Post-handoff revision editing remains future scope. Keep the supplied reference totals fixed when evaluating the clarified process; do not overwrite historical suites to reflect new requirements.

## Engineer walkthrough

1. Create an implementation plan. Request method suggestions, choose Agent for PDF interpretation and Code for deterministic validation/reporting, approve each choice, then approve the plan. Selecting the input packet already happens before execution; the trigger does not need an extra human approval merely because input selection was manual.
2. Generate the agent. Show its actual background phase, code files, source history and download. Syntax validation is separate from business correctness.
3. Under **Agent → Run workflow**, search existing Gmail, select all related invoice and certificate emails, enter the shipment reference, and capture them. Separate certificate replies belong in the same packet. Capture does not start a run.
4. In **Evaluation**, create cases using fixed captured inputs and independently verified totals. Verify every case, then lock the suite. Run the full suite against the chosen code version. Each result includes expected/actual values and a step trace; independent cases continue after an error.
5. Select an eligible failed evaluation and start **Repair and rerun**. Show the diagnosis, changed code, candidate results and retained baseline. The session stops after three attempts or earlier if it passes or needs an engineer decision. A regressing attempt remains visible but does not become the next baseline.
6. Start a manual run using a captured packet and the chosen code version. Inspect the seven totals, error details and report preview. Nothing is sent. Human blocks, when present in a workflow, pause for a fresh response on every visit.

Evaluation currently starts explicitly. Automatic first evaluation after generation remains a recommended enhancement; repair always starts explicitly.

## Import a prepared suite

For a larger supplied dataset, `npm run demo:suite -- <local-manifest.json>` creates a draft suite through the same services. The manifest contains `workflow_id`, `name`, and `cases`; every case contains `shipment_reference`, `input_bundle_id`, and `expected` with all seven nonnegative integer totals. Inputs must already belong to the frozen workflow. See the loader's schema for the exact format.

Only after checking every answer against an independent reference, add `--verified-and-lock` to record that verification and seal the suite. This is an operator assertion, not AI verification. No expected answers or real mailbox identifiers are bundled with the repository. Revisions create a new suite and preserve earlier evidence.

## Show failure honestly

An execution error means the case could not produce a valid answer; it is different from a completed result with incorrect counts. A report containing business failures can be the correct expected result. Never revise reference totals to hide a mismatch. Keep the frozen process and suite unchanged during repair, and show unresolved cases if the bounded session cannot fix them.

Use [implementation status](../implementation-status.md) for the latest measured outcomes, [runtime behavior](../features/workflow-runtime.md) for limits and retries, and [bounded repair](../features/bounded-repair.md) for acceptance rules.

## Independent policy counterexamples

The fictional PDFs and expectation manifest under `app/tests/fixtures/import-receiving/policy` supplement the supplied shipments. They test a supported packaging/manufacturing relationship and conflicting product, strength, and manufacturer evidence. All invoices contain the five required fields, so each negative case fails its batch while retaining a successful invoice. The corresponding README explains each independently chosen expectation. Filenames exposed to the reader should be neutral (`invoice.pdf`, `coa.pdf`); expected outcomes belong only in the locked evaluation case.

These are workflow inputs and expected results, not matching code in the platform. Capture the PDFs as source artifacts, add full-workflow cases to an explicit suite revision, verify/lock that revision, and re-evaluate the retained baseline before repair. Preserve the original shipment cases and prior suite/results. The PDFs exercise generated document reading without depending on private intermediate step schemas. They are optional live benchmarks, not LLM calls in required CI.
