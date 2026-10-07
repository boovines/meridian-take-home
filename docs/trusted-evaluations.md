# Evaluate an agent

Use **Evaluation** in `/workflows/:id/engineer` to compare a code version against verified examples. A syntax check only establishes that code can be parsed; an evaluation checks its behavior.

1. Create a test suite and add full-workflow or one-step cases. Workflow cases use captured inputs; step cases accept a JSON context.
2. Add expected values and output paths. Inspect the inputs and confirm the expected answers with **Verify inputs & answers**.
3. Lock the suite, select a code version, and choose **Run full suite**.
4. Open **Results & history** to compare values, inspect errors, or expand the step trace. Closing the page does not interrupt the work.

The results view keeps the case list beside its details. A pass means every check passed. Failed means a conclusive comparison disagreed. Inconclusive means evidence is incomplete, such as an execution error, missing human fixture, cancellation, or build blocker. Independent cases continue after an individual failure.

Correct an expected answer by creating a suite revision. Earlier expectations and results remain available; revised cases need verification again. **Run these versions again** repeats the exact historical code/suite pairing as a new evaluation.

The operation banner allows cancellation. The Agent tab also shows the latest evaluation status for its selected version. Full-workflow human actions use scripted responses for each visit; automated tests do not wait for a person. Reports are captured without sending email.

Bounded repair is implemented; see `bounded-repair.md`. Gmail capture and automatic first evaluation after generation remain pending. Current fixtures verify the interface and grading flow, not shipment accuracy.

See the [functional specification](../specs/trusted-evaluations.md) for validation rules, lifecycle details, and limits.
