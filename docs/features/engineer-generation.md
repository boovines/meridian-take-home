# Engineer workspace

Open **Engineer workspace** from a frozen whiteboard to turn the customer’s process into an implementation plan and inspectable code.

- **Implementation:** Create a plan, optionally request AI method suggestions, choose Code, Agent, or Human for each step, and approve the choices. Customer-required human steps stay human. Approve the complete plan to enable generation.
- **Agent:** Follow background progress, cancel an operation, select a completed code version, inspect its files, compare with its parent, and download the project ZIP.
- **Evaluation:** Author and verify a test suite, lock its expected answers, then explicitly run it against a code version. Inspect failures and start a bounded repair session. See [evaluations](trusted-evaluations.md) and [repair](bounded-repair.md).
- **Operation history:** Inspect completed, failed, or cancelled generation attempts. Existing code remains available while new work runs.
- **Frozen whiteboard:** Return to the customer’s unchanged process through the header link.

Generation continues when you close or reload the browser. A successful generation means the project was saved and its JavaScript passed syntax validation. It remains **Not yet evaluated** until business behavior is checked against trusted expectations.

A model response that is truncated or invalid produces a specific error; partial source is not accepted as a version. Previous complete versions remain inspectable.

Use **Revise plan** to change an approved method. A revision preserves the previous plan and code, copies choices into a new draft, and requires fresh approvals. Only one draft plan and one active expensive operation are allowed per workflow.

The workspace is at `/workflows/:id/engineer`; the source whiteboard is at `/workflows/:id`. The demo has no separate role permissions. There is no code editor, repository synchronization, automatic deployment, or email sending. Downloads invoke individual steps under a host; they do not silently bypass agent requests or human gates.

Known OpenAI project spending caps and exhausted quota stop code generation or repair with a specific explanation after the SDK call returns. The operation does not consume another worker generation invocation for the same quota error. Adding account credit may not change a project cap; restart explicitly after the relevant limit is updated. Provider payloads are not stored in the diagnostic. During workflow execution, these failures are infrastructure errors, not evidence for changing generated code. Transient rate limits keep the existing bounded retry behavior.

## Implementation contract

### Entry and users

After freezing a whiteboard, open **Engineer workspace** from the handoff banner. The workspace is available at `/workflows/:id/engineer`; its header links back to the unchanged customer whiteboard. The demo does not distinguish roles or permissions within the app. Deployment access must be protected separately.

The three workspace tabs are Implementation, Agent, and Evaluation. This specification covers plans and generated source; [trusted evaluations](trusted-evaluations.md), [bounded repair](bounded-repair.md), and [workflow execution](workflow-runtime.md) describe the subsequent execution surfaces.

### Implementation

Create a plan from the frozen process. Each step starts with Code selected unless the customer requires a human; the initial choices are unapproved. Suggest methods asks AI for a recommendation and short reason for each step. Recommendations are advisory and do not change selections or approvals. If the plan changes while suggestions are being prepared, those stale suggestions cannot overwrite it.

The engineer chooses Code, Agent, or Human for each step. Code performs deterministic work, Agent can request semantic interpretation, and Human requires a response before continuing. Human steps explicitly required by the customer cannot be changed to automated methods. Requirements expand in place beside the method and approval controls.

Approve each choice, then approve the plan. Changing a method clears its approval and requires a separate approval of the new choice. Concurrent stale edits are rejected; reloading shows the saved choices. Approved plans are immutable. Revise plan creates a separate draft that inherits choices but clears approvals. One draft plan is allowed at a time. Previous approved plans remain selectable.

### Generation

Generate agent requires an approved plan. It pins that plan and the currently latest generated code as the starting version, if one exists. Later plan revisions do not redirect an active generation. Only one expensive operation can run per workflow; inspection and preparing a plan revision remain available.

The operation progresses through queued, preparing, generating, validating, and publishing. The UI displays the current phase and a Cancel action. Closing or refreshing the browser does not cancel the operation. A queued operation waits for the background worker; it is not treated as successful simply because it was accepted.

AI writes a coordinated set of step implementations. Mandatory human gates come from the platform. Generated JavaScript is syntax-checked in an isolated environment without application credentials or network access. A complete project becomes an immutable code version before its syntax check, so invalid code can still be inspected and later repaired. The build-check outcome is recorded separately and never establishes business correctness.

Cancelled or expired work cannot publish new source after cancellation or expiry. Cancellation shows Stopping until acknowledged. Source saved before cancellation remains inspectable, with validation unfinished. A transient validation failure may retry using saved source, without regenerating it. Invalid source or an implementation requirement that needs an engineer decision ends the operation with an error. The operation has a finite time limit; starting again is explicit.

If the model reaches its response limit or returns an invalid response, generation ends with a specific explanation and does not publish partial source. Retrying is explicit; the frozen requirements and previous complete versions remain intact.

### Agent and history

Agent offers a code-version selector, a file list, read-only source, and Download project. A ZIP contains the exact selected version. Compare with parent shows prior and selected source; file labels identify additions, removals, modifications, and unchanged files. It is a before/after comparison, not an inline text editor.

Generated steps map back to the frozen process. The downloaded project includes its requirements, plan, module contract, and a command for invoking an individual step. It returns requests for agent or human handling to the host; it does not execute a complete workflow independently of that host.

Operation history preserves generation outcomes and errors. The source view labels versions Not yet evaluated. No emails or external reports are sent. The user must explicitly start subsequent work; nothing is published as a production agent automatically.

### Current limits

The latest 20 plans, code versions, and operations are listed. General repository connection, IDE edit import, and an in-browser editor are outside demo scope. Hosted artifact access requires private shared storage; local development artifacts remain on the machine that created them.

Method suggestions run while the request is open; generation runs durably in the background. The UI prevents starting competing operations but does not require a new AI recommendation before an engineer approves a revised plan. Model suggestions and source generation can fail; neither failure modifies the frozen customer process.
