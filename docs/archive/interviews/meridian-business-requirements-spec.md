# Meridian business requirements

> Archived interview/design record. Some proposed tables and execution responsibilities were intentionally superseded during implementation. Start with the [documentation index](../../README.md) and [current data-model audit](../../architecture/data-model.md); executable fields and constraints live in [migrations](../../../app/migrations).

Interview checkpoint — October 7, 2026. This completes the initial business-requirements pass, before selecting tables, column types, indexes, or infrastructure. Later decisions can refine this document.

## Product goal

A nontechnical process owner independently describes a workflow, uses AI review to clarify it, and freezes a stable specification. An engineer chooses how to implement each step, generates an implementation, evaluates it against trusted expectations, and starts a bounded repair loop when needed.

Preserve the interview's praised canvas experience, overall flow, and clear system diagram. Improve the customer-facing details, the durability and consistency of saved information, and the failure-handling loop. The model should support workflows beyond import receiving; that workflow is the concrete demo.

## Workspaces and drafting

- Support multiple independently saved workflows with a name, a list, and a Create action. Each workflow has its own draft, frozen specification, implementation, and evaluation history.
- Capture a workflow-level desired outcome in plain language, separate from terminal Outcome blocks. It may be blank while drafting; review asks the customer to supply or confirm it if missing before assessing whether steps are unnecessary. Goal changes count as semantic changes, and freeze preserves the goal.
- The customer primarily builds the canvas independently. Permissions, teams, folders, and sharing settings are outside demo scope.
- Keep reusable primitives for Trigger, Information, Task, Check, Human Handoff, Human Approval, and Outcome. Customers manually create and connect known exceptions and loops.
- Task entry uses a title and plain-language description, with prompts such as “What information do you use?”, “What do you check?”, and “What happens if it fails?” Avoid requiring a technical form up front.
- Persist task requirements in the task definition. Their eventual representation as text, a list, or structured fields remains a data-model decision.
- Each connection carries a plain-language condition. At a split, the customer explicitly chooses one matching path or parallel paths. A parallel merge waits for all paths launched by that split to finish. Repeated loop visits must remain distinguishable when implementing execution.
- The frozen definition must contain the approved instructions and transitions; generation must not reconstruct business rules from review conversations.
- At freeze, require exactly one active Trigger and require every active process block to be reachable from it. Drafts can be incomplete. Multiple triggers and explicitly excluded scratch blocks are not part of the demo.
- Parallel splits require an explicitly paired wait-for-all merge; overlapping parallel sections are deferred. For exclusive splits, multiple matching conditions stop the run. No matches use an optional explicit Otherwise route or produce a routing error; connection order does not break ties.
- Reject stale edits rather than overwriting changes saved from another tab. Preserve unsaved text for recovery; this does not introduce real-time collaboration.

## Review draft

The core whiteboard has Review draft instead of a preimplementation Test feature. Execution and evaluation belong after handoff.

Review explicitly looks for simplification opportunities as well as missing requirements: potentially redundant, duplicated, or unnecessary primitive blocks that do not contribute to the intended outcome. Explain why each candidate appears extraneous and what behavior or dependency could be affected by its removal. Consider exception paths, human approvals, and other stated requirements before judging usefulness; if a step's purpose is unclear, ask for clarification rather than asserting it is unnecessary. The customer decides whether to remove the block and manually repairs its connections. AI never deletes or rewires the graph. Use the same finding-resolution and history rules as other suggestions, including rejection with a reason and eligible automatic closure when a sole referenced block is deleted.

1. The customer requests review. The canvas is read-only while review is running, with an option to cancel and resume editing. A canceled review must not later publish results onto a changed draft.
2. AI uses a temporary clarification panel to ask consequential questions before publishing findings. “Temporary” describes the interface; the retention of answers is addressed below.
3. Review publishes substantive findings anchored to the relevant blocks, connections, or broader workflow. It does not comment on every block.
4. The customer edits and resolves findings, then can request another review. Open issues receive follow-up in the same finding rather than duplicate findings.
5. Resolved or rejected decisions remain authoritative. AI disagreement does not reopen them or block freeze. The customer can reopen a finding while still drafting, preserving the previous disposition and explanation in history; it then blocks freeze again. If a material process change makes an earlier decision newly relevant to AI review, create a new finding linked to the earlier one and explain what changed. Preserve the original decision. Reopening after freeze is outside demo scope.

AI suggestions never overwrite customer input. A clarification of an existing block can have a proposed before/after edit, explicitly accepted by the customer. A change to routing, actions, or process behavior is explained and highlighted, but the customer edits the graph manually. The boundary is semantic: adding a new escalation is a process change even if it could be written into an existing description field.

For permitted block-detail edits, offer Apply and resolve: apply the approved edit and close the finding atomically, checking the expected block and finding revisions. A stale edit fails as a whole. Graph changes remain manual with separate resolution. Customers can also create ordinary comment threads; these do not block freeze. Notes can inform review, but implementation-relevant instructions must still be incorporated into the workflow definition.

Every AI review finding must be addressed before freeze. Customers can implement the suggestion, clarify the existing process, or reject it. Recommended resolution UI: “Updated the workflow,” “Clarified the existing process,” and “No change needed.” Require a brief answer or reason when closing without a workflow change; make explanations optional when confirming an actual edit. The customer judges whether the finding is addressed; AI does not validate the quality of their reason as a freeze gate. Ordinary replies are not separate blockers.

Deletion exception: when an open finding's only referenced block is deleted, automatically close it with a target-deleted reason. Preserve its history and removed-block context. Findings spanning other blocks remain open, and previously closed findings retain their original decisions.

Clarification answers that affect implementation belong in the relevant task or workflow definition. Review history records how the decision was reached. If the answer requires new actions or routes, encourage the canvas modification and allow rejection with a reason; do not silently generate a graph edit.

The assignment demonstration should include at least two review rounds. This is a demo requirement, not a hard limit on reviews or a requirement to review every edit.

## Freeze and handoff

- Require at least one successfully completed AI review, all AI findings addressed, and passing definite structural checks. Examples include valid connection endpoints and an explicit split mode. The validator is distinct from AI judgment about the business process. Customer notes do not block freeze; the assignment's two-round demonstration is separate from the one-review product minimum.
- If the draft changed since review, offer another review and show an unreviewed-changes warning. The customer can acknowledge it and freeze without another review.
- Freeze captures the current resolved workflow definition and its transitions as an immutable specification, with the relevant decision history and any acknowledgment of unreviewed changes.
- Anyone using the demo can press Freeze; no role-based approval system is required.
- Freezing locks the board for the demo. New drafts and revisions after handoff are future scope.
- Engineers see the exact frozen specification they are implementing, not a mutable canvas that can change underneath them.

## Implementation and generated code

- Retain the Implementation, Agent, and Evaluation views.
- AI recommends Code, Agent, or Human for each relevant step. The engineer approves implementation methods before generation. Human approvals required by the customer remain mandatory and cannot be removed through method selection or repair.
- Approved implementation choices can be revised by creating a new plan version. Preserve prior plans, code, and evaluations. Business expectations remain applicable; implementation-specific tests may need an explicitly verified suite revision.
- Show generated code and diffs in a read-only web view and allow downloading the generated project. No browser IDE is needed.
- Evaluate and repair app-managed code versions. Importing external IDE edits and connecting hosted repositories are outside demo scope.
- Every evaluation must identify the exact implementation version tested. Repair history preserves the attempted changes and their results.
- Allow only one active generation, evaluation, or repair operation per workflow, including across tabs or retried requests. Existing code/results remain inspectable. A repair session's internal evaluations are part of that same operation; separate workflows can run independently.
- Recommended launch default: when a locked, trusted suite is selected, generation automatically starts the first evaluation; the engineer explicitly starts Repair and rerun. This retains the earlier recommendation. Without a locked suite, show Generated—not yet evaluated. Automatic first evaluation is an implementation default, not a separately confirmed requirement.

## Evaluation and repair

Meridian's provided shipment-number ground truth is authoritative for the demo's expected results. Its visible reports include shipment-level invoice, failed-good, and CoA totals. Mismatched invoices are explicitly excluded by Alfonso; do not add an acceptance criterion for that column. This exclusion does not by itself remove the SOP's batch/CoA matching requirements.

- Score final shipment outputs against the supplied expected results. Capture each step's inputs, outputs, and errors to support diagnosis. A failing final total establishes a failure, not a verified diagnosis of its cause.
- Add focused unit tests for deterministic rules and integration tests for step boundaries. Example: two missing fields on one good produce one failed good with two missing-field details; a failed good causes its invoice to fail.
- Add intermediate expectations where needed for diagnosis. For extraction, use a few sample PDFs with independently verified important values. Comparing OCR implementations alone does not establish correctness.
- AI can help structure supplied expectations or propose tests. Expected answers need independent verification; tests that merely mirror generated code are insufficient.
- Lock the trusted tests, their expected values, and sample inputs for a repair session. The repair agent cannot modify these or the frozen workflow to make a result pass.
- Engineers can explicitly correct tests by creating a newly verified suite version. Preserve the old expectations and results. End any active repair session and reevaluate its selected baseline against the new suite before another repair session starts.
- Each repair runs applicable step tests and the shipment regression suite, including previously passing cases.
- Demo evaluation controls run the full locked suite. Targeted internal checks are diagnostic; a candidate needs a full-suite result before it can become the repair baseline, and partial results cannot count as an overall pass.
- Continue independent cases after an individual failure or execution error, preserving each result. A shared prerequisite failure such as the generated project not building blocks the evaluation. Distinguish assertion failures, execution errors, and shared blockers so infrastructure failures do not trigger inappropriate code repairs.
- Preserve regressing candidates in history, but continue repair from the last non-regressing baseline. Compare individual check outcomes on the same suite rather than only total pass counts.
- A repair session allows at most three repair attempts, then stops with Needs engineer attention, remaining failures, and attempted changes. The engineer can inspect the results and explicitly start another session.
- Repairs may change code and prompts within approved methods. If progress requires changing an approved method, stop for an engineer decision. Required human approvals remain fixed.
- Changes to the frozen business process are outside demo scope. If a failure requires such a change, explain the blocker rather than silently modifying the specification. Suspected ground-truth errors also require investigation outside the repair loop.
- Recommended failure distinction: operational problems such as Gmail authentication failure should surface as access/infrastructure issues rather than automatically trigger business-logic rewrites.

## Shipment runs and human steps

- The user explicitly selects an existing shipment email or supplies a shipment number to start a run. Retrieve the real Gmail documents. Continuous inbox monitoring is future scope.
- Recommended evaluation behavior: preserve a fixed copy of retrieved sample inputs so reruns process identical documents.
- Produce a captured report preview with intended recipient, subject, and body. Do not send email in the demo, evaluation, or repair loop.
- An ordinary run reaching a Human Handoff or Human Approval step pauses, presents an in-app question or decision, records the response, and resumes along the appropriate connection. No assignments, notifications, or role permissions are required.
- Human responses are text or approval/rejection only. Supplying changed documents creates a new input bundle and a new run; uploads into a paused run are future scope.
- Require a fresh human response for every visit, including repeat visits caused by loops. A response belongs to a specific run and step occurrence; automatic approval reuse is outside scope.
- Recommended evaluation behavior: represent human responses as predefined test inputs. These simulate the interaction for testing; ordinary runs must still wait for a real response.
- Apply fixed server-side step-execution and active-time limits and record the applied values on each run. Stop with Needs attention when a limit is reached. Human waiting does not consume active execution allowance; exact limits require calibration.
- If a required parallel branch crashes, let already-running independent work finish within the run limits, retain its outputs, and stop before the incomplete merge. Business-invalid results are different from execution crashes and can follow the modeled exception route.
- Retrying a failed run creates a new run from the beginning with the same code and input bundle, linked to its predecessor. Preserve the failed trace and require fresh human responses. General failed-step resume is future scope.

## Operational defaults to carry into system design

These are recommendations rather than independently confirmed interview answers:

- Aim for a hosted demo, potentially with Vercel serving the web app. Hosting the generation/evaluation worker is a separate design choice; no provider has been committed.
- Long-running jobs continue independently of an open browser tab. On return, show their current stage, completed work, failures, and results. Avoid invented progress percentages.
- Save drafts and review decisions so a customer can leave and return. Show unsaved/save-failure state. Exact autosave behavior remains a design decision; stale-save rejection is confirmed above.
- Keep review input identity, finding history, code version identity, evaluation-suite identity, and run outcomes durable enough to explain results after refresh.
- Do not infer multiuser real-time collaboration or a production traffic target. Workload estimates, retention limits, and performance targets still need explicit assumptions before optimization.
- Confirm the chosen demo cuts against assignment requirements before calling the end-to-end demo complete, particularly manual Gmail initiation and preview-only report delivery.

## Actions and questions the data model must support

| User action | Information that must be retained or retrieved |
| --- | --- |
| List and resume workflows | Workflow identity, name, draft/frozen state, current saved content |
| Edit a primitive or connection | Stable identity, ownership by workflow, definition, canvas placement, routing conditions and split/merge behavior |
| Request or cancel review | Reviewed draft identity, review state, clarification exchange, resulting findings, cancellation state |
| Address a finding | Affected scope, conversation/replies, decision, explanation, proposed/applied edit, links to earlier findings |
| Freeze | Exact instructions and transitions, structural validity, addressed findings, acknowledged unreviewed edits |
| Approve implementation | Frozen input, proposed/chosen methods, engineer approvals, immutable human requirements |
| Generate or inspect code | Job progress, code artifact/version, file contents or references, diffs and download |
| Evaluate | Fixed input case, trusted expectations, implementation version, actual result, comparisons, step traces |
| Repair and rerun | Session and attempt identity, diagnosis, code change, tested version, regression results, stopping reason |
| Pause and resume for a human | Run and step occurrence, pending question/decision, response, resulting continuation |
| Inspect a shipment report | Source shipment, run identity, invoice/good/CoA findings, intended email content |

This is a requirements inventory, not a table list. One row in this inventory does not imply one database table. Next, trace representative operations, identify independently changing records and relationships, and only then choose columns, constraints, transactions, and indexes.

## Future and excluded scope

The README maintains a concise future-work list. Deferred capabilities include post-handoff workflow revisions, external IDE edits and hosted repository synchronization, continuous Gmail monitoring, actual report delivery, automated process mining, and SOP upload to generate a starter canvas. Broad OCR benchmarking is also deferred. Permissions, teams, and real-time collaboration are not required for the demo. Mismatched invoices are excluded from this assignment rather than promised as a future feature.

## References

- [PRDs, first two tabs](https://docs.google.com/document/d/1ARjmPNDBDeczJDOFiMdOHB7r4_Z6-9CQCb2Mm7PHjiA/edit?usp=sharing)
- [Excalidraw](https://excalidraw.com/#json=HNYCoP1dpo9_4UKlbthMq,OPURrme2-BkYp_gVSNDvbg)
- [Meeting notes](https://notes.granola.ai/t/94e22a38-8fc4-44ab-826b-df0eb5ce1952)
- [Supplied ground truth](https://app.notion.com/p/Justin-Take-Home-Ground-Truth-3bcfdc07926d804483d0ec0a73c6358a)

The ground-truth page also contains access credentials. No credentials are copied into this document or the repository.
