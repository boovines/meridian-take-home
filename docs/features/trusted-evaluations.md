# Evaluate an agent

Use **Evaluation** in `/workflows/:id/engineer` to compare a code version against verified examples. A syntax check only establishes that code can be parsed; an evaluation checks its behavior.

1. Create a test suite and add full-workflow or one-step cases. Workflow cases use captured inputs; step cases accept a JSON context.
2. Add output paths and expected values. Choose **Equals exactly**, **Contains a record**, or **Excludes a record**. Inspect the inputs and confirm the expected answers with **Verify inputs & answers**.
3. Lock the suite, select a code version, and choose **Run full suite**.
4. Open **Results & history** to compare values, inspect errors, or expand the step trace. Closing the page does not interrupt the work.

The results view keeps the case list beside its details. A pass means every check passed. Failed means a conclusive comparison disagreed. Inconclusive means evidence is incomplete, such as an execution error, missing human fixture, cancellation, or build blocker. Independent cases continue after an individual failure.

Correct an expected answer by creating a suite revision. Earlier expectations and results remain available; revised cases need verification again. **Run these versions again** repeats the exact historical code/suite pairing as a new evaluation.

When final totals do not explain a failure, add independently checked evidence comparisons in a new suite revision. For example, require a record with the original identifier and source document, regardless of where it appears in the output array. Use a descriptive label that names the inspected page. Preserve the existing totals; a more detailed check should diagnose a mismatch, not redefine success to match the agent.

The operation banner allows cancellation. The Agent tab also shows the latest evaluation status for its selected version. Full-workflow human actions use scripted responses for each visit; automated tests do not wait for a person. Reports are captured without sending email.

Bounded repair and Gmail capture are available; see [bounded repair](bounded-repair.md) and [capturing inputs](gmail-inputs.md). Evaluations start explicitly after generation. One-step cases use supplied JSON context and can optionally reference an immutable captured document bundle for isolated extraction checks. Current fixtures verify the interface and grading flow, not shipment accuracy.

## Implementation contract

The engineer checks generated behavior against independently verified expectations in the Evaluation tab at `/workflows/:id/engineer`. A suite is a versioned collection of cases. An evaluation binds one locked suite to one immutable code version. Finishing the operation and passing the tests are separate outcomes.

### Authoring and verification

The Test cases view lets the engineer create a named suite, add cases, inspect inputs, edit or remove draft cases, verify each case, and lock the suite. Every case has a name and at least one comparison. A comparison selects an output path using a JSON array of keys and declares an expected JSON value. Array positions use string keys such as "0". An empty path selects the entire output.

**Equals exactly** compares the complete value: object key order does not matter; array order does. A missing field differs from an explicit null. Existing assertions without an `operator` retain this behavior and are not rewritten.

**Contains a record** (`contains_record`) requires the selected output to be an array with at least one object matching every expected top-level field. **Excludes a record** (`excludes_record`) requires that no such object appears. Expected values must be nonempty JSON objects; additional fields on an actual record are allowed. Fields must match within the same record. Nested objects and arrays use exact equality, without normalization, substring matching or recursive partial matching. Missing or non-array output fails both operators. An empty array passes an exclusion check but fails an inclusion check. These operators establish presence or absence, not uniqueness or document completeness. Results retain the selected array for inspection and label the expectation Required record or Forbidden record.

Comparison labels can identify the independently inspected source page. Engineers can check source evidence as well as final totals when that evidence is included in the final output; the system does not create or verify these expectations automatically. Assertion operators live in the existing JSONB case definition, so no table or migration is added. Suite revision and locking rules apply to operators and expected values together.

A full-workflow case selects a previously captured input and runs the frozen process from its entry point. A one-step case selects a frozen block and supplies its input, previous step outputs, and any required human response. It checks the output of that implementation in isolation, including valid routing. This does not establish full-workflow correctness.

Full-workflow cases can include scripted human responses keyed to a block and its visit number. Every required visit needs its own response. Missing or incompatible responses produce an execution error; automated evaluation never waits for a real person or accepts a live response in place of the locked fixture.

Save case records a draft, not a verified answer. Verify inputs & answers is the engineer's explicit confirmation of the current case. Any subsequent edit clears that confirmation. Conflicting edits fail and leave the form text available. Lock verified suite requires at least one case and verification of all cases. Locked cases cannot be edited or removed. Create suite revision copies the cases into a new draft, clears their verification, and preserves the earlier suite and results. Only one draft suite is allowed per workflow.

### Running and inspecting

Run full suite uses the selected code and locked suite. One expensive operation can run per workflow; existing cases, code, and results remain inspectable. Work survives closing the browser. The operation banner reports phase and allows cancellation.

The shared build check runs first. If the project cannot build or the execution service is unavailable, the evaluation is blocked and unexecuted cases are shown as not run. Otherwise cases run independently in sequence. A failed assertion or case execution error does not prevent later cases from running.

Results & history shows the exact code/suite pairing, outcome, and number of cases passed. The case list remains beside the selected case's expected and actual values. A failed comparison shows both values; an execution error shows its category and cause without inventing assertion failures. Inspect test inputs and Complete actual output reveal the captured evidence. Full-workflow cases also expose an expandable step trace with repeated visits, prior outputs, human responses, errors, and final outputs. Run these versions again creates a new evaluation of that exact pairing.

The Agent tab reports the most recent evaluation of its selected code version and the associated suite number. Syntax validation remains a separate claim.

### Completion rules and limits

- **Passed:** every case completed and every comparison passed.
- **Failed:** all cases were evaluated conclusively and at least one comparison failed.
- **Inconclusive:** any case errored, did not run, or lacks complete evidence. Cancellation and shared blockers are always inconclusive.
- A completed evaluation may therefore be failed or inconclusive. Old results cannot be edited into passes.
- Cases have at most 100 comparisons and 100 scripted responses. Suites have at most 50 cases. Definitions are limited to 100 KB; large documents belong in captured inputs.
- The operation has a four-hour limit. Each full-workflow case also retains the runtime's fixed step and active-time limits. The worker has bounded infrastructure retries; late attempts cannot replace a newer result.
- No email is sent. Output reports remain data available for inspection.

### Constraints and pending work

The current UI starts evaluations explicitly; generation does not start them automatically. Autonomous repair and Gmail input capture are implemented as separate features. There is no OCR benchmark library, arbitrary test-code editor, selected-case acceptance run, or import of IDE changes. Step checks currently compare JSON outputs, rather than accepting arbitrary engineer-authored test scripts. Isolated step cases may optionally reference an immutable captured document bundle. When present, its input replaces the fixture input and the Agent can read only that bundle’s source artifacts. This allows field-level extraction diagnostics without running downstream steps; the same locked expectations, audit history and grading rules apply. Exact comparisons do not normalize formatting; record checks must be selected explicitly and do not compare entire unordered collections.

The local test executor is visibly labeled as a fixture. It verifies UI/persistence/grading behavior with known outputs and does not execute generated source. Live execution uses isolated environments. Shipment accuracy must be verified separately against supplied real inputs and ground truth.

Anyone with access to the protected demo can act as the engineer; role and team permissions are outside scope. Suite verification is an explicit user action, not a claim that the system independently knows an expected answer is correct.

Supplemental source checks can require text containment (ignoring case and whitespace only) or exact array membership. These are explicit assertion operators, not fuzzy matching: no spelling correction, unit conversion, punctuation removal or identifier suffix stripping occurs. Text checks establish the specified fragment, not correctness of the entire field. Pair them with record counts and exact identifiers where independently verified. Existing equals/record assertions retain their original semantics.

Evaluation settings are also checked at the actual step invocation boundary. If a worker restarts with different settings after a case was scheduled, both isolated cases and full-workflow steps stop with an infrastructure error before calling the new model. This prevents a mixed-configuration run from counting toward confirmation.

When the optional inference budget guard is enabled, token counting may make at most three attempts for transient HTTP/transport failures, within a shared 120-second deadline and the caller's cancellation signal. Permanent failures, invalid counts, or exhausted attempts stop before inference; the guard never bypasses the reservation. This policy is included in the evaluation configuration. A successful reservation retains the count-attempt number and failure types; failed preflights carry the same bounded diagnostic labels without provider payloads. Caller cancellation remains cancellation, including during body reading and backoff. The internal deadline is an infrastructure error. Only native-fetch network TypeErrors and the listed transient HTTP statuses are retried; unexpected adapter errors stop immediately. Server backoff beyond the remaining deadline stops without another request. These retries concern a read-only token count, not repeated generated answers or replacement evaluation runs. Changing the policy starts a distinct measurement configuration; earlier passes cannot complete its confirmation sequence.

The case editor preserves an isolated step case’s captured input when editing. Choose **Use JSON input only** to remove that optional bundle explicitly; selecting a bundle replaces the fixture’s `input` at execution while retaining its prior-step context.

The recorded configuration also includes the runtime heartbeat policy. Let active operations finish or cancel them before restarting the web app and worker consistently for a policy change, then start a distinct confirmation sequence. Already scheduled activity timeouts in Temporal history are not rewritten by updating the worker. Earlier passes under a different policy do not count toward that sequence. The longer heartbeat allowance is liveness tolerance, not permission to extend inference time, repeat failed business answers, or treat infrastructure errors as successful cases.
