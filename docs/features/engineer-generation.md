# Engineer workspace

Open **Engineer workspace** from a frozen whiteboard to turn the customer’s process into an implementation plan and inspectable code.

- **Implementation:** Create a plan, optionally request AI method suggestions, choose Code, Agent, or Human for each step, and approve the choices. Customer-required human steps stay human. Approve the complete plan to enable generation.
- **Agent:** Follow background progress, cancel an operation, select a completed code version, inspect its files, compare with its parent, and download the project ZIP.
- **Evaluation:** Author and verify a test suite, lock its expected answers, then explicitly run it against a code version. Inspect failures and start a bounded repair session. See [evaluations](trusted-evaluations.md) and [repair](bounded-repair.md).
- **Operation history:** Inspect completed, failed, or cancelled generation attempts. Existing code remains available while new work runs.
- **Process whiteboard:** Return to the working canvas through the header link; it may contain a new draft. The Frozen process selector controls the immutable version used in the engineer workspace.

Generation continues when you close or reload the browser. A successful generation means the project was saved and its JavaScript passed syntax validation. It remains **Not yet evaluated** until business behavior is checked against trusted expectations.

A model response that is truncated or invalid produces a specific error; partial source is not accepted as a version. Previous complete versions remain inspectable.

Use **Revise plan** to change an approved method. A revision preserves the previous plan and code, copies choices into a new draft, and requires fresh approvals. Only one draft plan is allowed per frozen process version. One active expensive operation is allowed across the workflow.

The workspace is at `/workflows/:id/engineer`; the source whiteboard is at `/workflows/:id`. The demo has no separate role permissions. There is no code editor, repository synchronization, automatic deployment, or email sending. Downloads invoke individual steps under a host; they do not silently bypass agent requests or human gates.

Known OpenAI project spending caps and exhausted quota stop code generation or repair with a specific explanation after the SDK call returns. The operation does not consume another worker generation invocation for the same quota error. Adding account credit may not change a project cap; restart explicitly after the relevant limit is updated. Provider payloads are not stored in the diagnostic. During workflow execution, these failures are infrastructure errors, not evidence for changing generated code. Transient rate limits keep the existing bounded retry behavior.

## Implementation contract

### Entry and users

After freezing a whiteboard, open **Engineer workspace** from the handoff banner. The workspace is available at `/workflows/:id/engineer`; its header links back to the customer’s working whiteboard. The demo does not distinguish roles or permissions within the app. Deployment access must be protected separately.

The three workspace tabs are Implementation, Agent, and Evaluation. This specification covers plans and generated source; [trusted evaluations](trusted-evaluations.md), [bounded repair](bounded-repair.md), and [workflow execution](workflow-runtime.md) describe the subsequent execution surfaces.

### Implementation

Create a plan from the frozen process. Each step starts with Code selected unless the customer requires a human; the initial choices are unapproved. Recommend methods with AI asks the model for a recommendation and short reason for each step. Suggestions populate and save the draft method selections along with their reasons. A changed method clears its previous approval; an unchanged method retains its existing approval. Suggestions never approve a step automatically. The engineer can override any suggestion except a customer-required human method. If the plan changes while suggestions are being prepared, those stale suggestions cannot overwrite it.

The engineer chooses Code, Agent, or Human for each step. Code performs deterministic work, Agent can request semantic interpretation, and Human requires a response before continuing. Human steps explicitly required by the customer cannot be changed to automated methods. Requirements expand in place beside the method and approval controls.

Approve each choice, then approve the plan. Changing a method clears its approval and requires a separate approval of the new choice. Concurrent stale edits are rejected; reloading shows the saved choices. Approved plans are immutable. Revise plan creates a separate draft that inherits choices but clears approvals. One draft plan is allowed at a time. Previous approved plans remain selectable.

### Generation

Generate agent requires an approved plan. It pins that plan and the currently latest generated code as the starting version, if one exists. Later plan revisions do not redirect an active generation. Only one expensive operation can run per workflow; inspection and preparing a plan revision remain available.

The operation progresses through queued, preparing, generating, validating, and publishing. The UI displays the current phase and a Cancel action. Closing or refreshing the browser does not cancel the operation. A queued operation waits for the background worker; it is not treated as successful simply because it was accepted.

AI writes a coordinated set of step implementations. Mandatory human gates come from the platform. Generated JavaScript is syntax-checked in an isolated environment without application credentials or network access. A complete project becomes an immutable code version before its syntax check, so invalid code can still be inspected and later repaired. The build-check outcome is recorded separately and never establishes business correctness. Starting another evaluation retains the latest definitive build evidence for the same code version, even while the latest evaluation is running. A later build failure supersedes an earlier pass.

Cancelled or expired work cannot publish new source after cancellation or expiry. Cancellation shows Stopping until acknowledged. Source saved before cancellation remains inspectable, with validation unfinished. A transient validation failure may retry using saved source, without regenerating it. Invalid source or an implementation requirement that needs an engineer decision ends the operation with an error. The operation has a finite time limit; starting again is explicit.

If the model reaches its response limit or returns an invalid response, generation ends with a specific explanation and does not publish partial source. Retrying is explicit; the frozen requirements and previous complete versions remain intact.

### Agent and history

Agent offers a code-version selector, a file list, read-only source, and Download project. A ZIP contains the exact selected version. Compare with parent shows prior and selected source; file labels identify additions, removals, modifications, and unchanged files. It is a before/after comparison, not an inline text editor.

Generated steps map back to the frozen process. The downloaded project includes its requirements, plan, module contract, and a command for invoking an individual step. It returns requests for agent or human handling to the host; it does not execute a complete workflow independently of that host.

Operation history preserves generation outcomes and errors. The source view labels versions Not yet evaluated. No emails or external reports are sent. The user must explicitly start subsequent work; nothing is published as a production agent automatically.

### Current limits

The latest 20 plans, code versions, and operations are listed. General repository connection, IDE edit import, and an in-browser editor are outside demo scope. Hosted artifact access requires private shared storage; local development artifacts remain on the machine that created them.

Method suggestions run while the request is open; generation runs durably in the background. The UI prevents starting competing operations but does not require a new AI recommendation before an engineer approves a revised plan. Model suggestions and source generation can fail; neither failure modifies the frozen customer process.

Build evidence is recorded explicitly per evaluation and immutable code version after the isolated syntax check. A fixture completion does not prove a build passed. Reruns preserve the latest definitive result, ordered by check time; a later build failure overrides older success and generation labels. Cancellation or infrastructure failures do not create a build verdict. Historical evaluations without explicit checks remain unknown; generation checks remain available separately. Migration 014 adds this evidence without backfilling assumed passes.

Generation failures display a concise error card with expandable diagnostic details. When generation needs an engineer decision, Review implementation returns to the plan tab; the full provider explanation remains available. This presentation does not change approved methods or retry generation automatically.

## Engineer-requested process revisions

From Implementation, use **Request changes** beside **Recommend methods with AI**. Enter the missing rule or change and optionally select affected blocks. Sending the request preserves the approved process and opens a persistent conversation on the whiteboard. The request retains the original wording and engineer attribution. Closing or canceling the dialog does not submit it; a failed send keeps the draft for retry.

The process expert can answer in the existing review conversation without unlocking the board. AI proposes editable block names and instructions. Every affected block has a separate Accept or Reject action; neither a reply nor a proposal changes the canvas. **Start revision** explicitly opens the next working draft. Only then can the expert accept proposed changes. Stale proposals require a fresh reply, and graph topology changes remain manual. The expert resolves a request with a reason after saving the agreed changes, or rejects it with a reason without starting a revision.

A revised process needs a completed review for that revision, dispositions on its findings and engineer requests, valid structure, and acknowledgment of later unreviewed edits. Freezing creates a new immutable version and a new unapproved implementation plan. Choices carry forward only when the block and its upstream executable context are unchanged; layout changes do not invalidate them. Changed steps use initial method defaults, and every step needs explicit approval again. Required human steps stay Human. No code version or pass label carries forward.

The **Frozen process** selector scopes plans, code, suites, evaluations and manual-run defaults. Earlier operations keep their original process even if a new version is frozen while they run. A recovered historical implementation can become that historical version’s default only. The global operation banner identifies the version currently executing; it continues to prevent competing expensive operations.

The demo records engineer/customer actions but does not authenticate separate roles. There is one mutable draft, no simultaneous branches, automatic notifications or automatic graph rewrites. Grouped email execution is a separate [implemented feature](grouped-execution.md), with its own acceptance evidence.

Verification: the process-revision browser journey exercises request, reply, per-block approval, fresh review, v2 handoff/generation and v1 history. Persistence tests cover idempotent requests/revision starts, rejected and stale edits, immutable specifications, required human gates and historical generation/recovery pinning. Fixture success does not establish live model quality.
