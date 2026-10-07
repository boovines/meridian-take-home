# Trusted evaluations

The engineer checks generated behavior against independently verified expectations in the Evaluation tab at `/workflows/:id/engineer`. A suite is a versioned collection of cases. An evaluation binds one locked suite to one immutable code version. Finishing the operation and passing the tests are separate outcomes.

## Authoring and verification

The Test cases view lets the engineer create a named suite, add cases, inspect inputs, edit or remove draft cases, verify each case, and lock the suite. Every case has a name and at least one exact comparison. A comparison selects an output path using a JSON array of keys and declares an expected JSON value. An empty path compares the entire output. Object key order does not matter; array order does. A missing field is different from an explicit null.

A full-workflow case selects a previously captured input and runs the frozen process from its entry point. A one-step case selects a frozen block and supplies its input, previous step outputs, and any required human response. It checks the output of that implementation in isolation, including valid routing. This does not establish full-workflow correctness.

Full-workflow cases can include scripted human responses keyed to a block and its visit number. Every required visit needs its own response. Missing or incompatible responses produce an execution error; automated evaluation never waits for a real person or accepts a live response in place of the locked fixture.

Save case records a draft, not a verified answer. Verify inputs & answers is the engineer's explicit confirmation of the current case. Any subsequent edit clears that confirmation. Conflicting edits fail and leave the form text available. Lock verified suite requires at least one case and verification of all cases. Locked cases cannot be edited or removed. Create suite revision copies the cases into a new draft, clears their verification, and preserves the earlier suite and results. Only one draft suite is allowed per workflow.

## Running and inspecting

Run full suite uses the selected code and locked suite. One expensive operation can run per workflow; existing cases, code, and results remain inspectable. Work survives closing the browser. The operation banner reports phase and allows cancellation.

The shared build check runs first. If the project cannot build or the execution service is unavailable, the evaluation is blocked and unexecuted cases are shown as not run. Otherwise cases run independently in sequence. A failed assertion or case execution error does not prevent later cases from running.

Results & history shows the exact code/suite pairing, outcome, and number of cases passed. The case list remains beside the selected case's expected and actual values. A failed comparison shows both values; an execution error shows its category and cause without inventing assertion failures. Inspect test inputs and Complete actual output reveal the captured evidence. Full-workflow cases also expose an expandable step trace with repeated visits, prior outputs, human responses, errors, and final outputs. Run these versions again creates a new evaluation of that exact pairing.

The Agent tab reports the most recent evaluation of its selected code version and the associated suite number. Syntax validation remains a separate claim.

## Completion rules and limits

- **Passed:** every case completed and every comparison passed.
- **Failed:** all cases were evaluated conclusively and at least one comparison failed.
- **Inconclusive:** any case errored, did not run, or lacks complete evidence. Cancellation and shared blockers are always inconclusive.
- A completed evaluation may therefore be failed or inconclusive. Old results cannot be edited into passes.
- Cases have at most 100 comparisons and 100 scripted responses. Suites have at most 50 cases. Definitions are limited to 100 KB; large documents belong in captured inputs.
- The operation has a four-hour limit. Each full-workflow case also retains the runtime's fixed step and active-time limits. The worker has bounded infrastructure retries; late attempts cannot replace a newer result.
- No email is sent. Output reports remain data available for inspection.

## Constraints and pending work

The current UI starts evaluations explicitly. Automatically evaluating a selected locked suite after initial generation remains planned. Autonomous repair and Gmail input capture are separate pending features. There is no OCR benchmark library, arbitrary test-code editor, selected-case acceptance run, or import of IDE changes. Step checks currently compare JSON outputs, rather than accepting arbitrary engineer-authored test scripts.

The local test executor is visibly labeled as a fixture. It verifies UI/persistence/grading behavior with known outputs and does not execute generated source. Live execution uses isolated environments. Shipment accuracy must be verified separately against supplied real inputs and ground truth.

Anyone with access to the protected demo can act as the engineer; role and team permissions are outside scope. Suite verification is an explicit user action, not a claim that the system independently knows an expected answer is correct.
