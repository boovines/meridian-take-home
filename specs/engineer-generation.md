# Engineer plans and generated code

## Entry and users

After freezing a whiteboard, open **Engineer workspace** from the handoff banner. The workspace is available at `/workflows/:id/engineer`; its header links back to the unchanged customer whiteboard. The demo does not distinguish roles or permissions within the app. Deployment access must be protected separately.

The three workspace tabs are Implementation, Agent, and Evaluation. The current feature implements the first two; Evaluation explains that correctness still needs a verified suite. It does not display a fabricated passing result.

## Implementation

Create a plan from the frozen process. Each step starts with Code selected unless the customer requires a human; the initial choices are unapproved. Suggest methods asks AI for a recommendation and short reason for each step. Recommendations are advisory and do not change selections or approvals. If the plan changes while suggestions are being prepared, those stale suggestions cannot overwrite it.

The engineer chooses Code, Agent, or Human for each step. Code performs deterministic work, Agent can request semantic interpretation, and Human requires a response before continuing. Human steps explicitly required by the customer cannot be changed to automated methods. Requirements expand in place beside the method and approval controls.

Approve each choice, then approve the plan. Changing a method clears its approval and requires a separate approval of the new choice. Concurrent stale edits are rejected; reloading shows the saved choices. Approved plans are immutable. Revise plan creates a separate draft that inherits choices but clears approvals. One draft plan is allowed at a time. Previous approved plans remain selectable.

## Generation

Generate agent requires an approved plan. It pins that plan and the currently latest generated code as the starting version, if one exists. Later plan revisions do not redirect an active generation. Only one expensive operation can run per workflow; inspection and preparing a plan revision remain available.

The operation progresses through queued, preparing, generating, validating, and publishing. The UI displays the current phase and a Cancel action. Closing or refreshing the browser does not cancel the operation. A queued operation waits for the background worker; it is not treated as successful simply because it was accepted.

AI writes a coordinated set of step implementations. Mandatory human gates come from the platform. Generated JavaScript is syntax-checked in an isolated environment without application credentials or network access. A complete project becomes an immutable code version before its syntax check, so invalid code can still be inspected and later repaired. The build-check outcome is recorded separately and never establishes business correctness.

Cancelled or expired work cannot publish new source after cancellation or expiry. Cancellation shows Stopping until acknowledged. Source saved before cancellation remains inspectable, with validation unfinished. A transient validation failure may retry using saved source, without regenerating it. Invalid source or an implementation requirement that needs an engineer decision ends the operation with an error. The operation has a finite time limit; starting again is explicit.

## Agent and history

Agent offers a code-version selector, a file list, read-only source, and Download project. A ZIP contains the exact selected version. Compare with parent shows prior and selected source; file labels identify additions, removals, modifications, and unchanged files. It is a before/after comparison, not an inline text editor.

Generated steps map back to the frozen process. The downloaded project includes its requirements, plan, module contract, and a command for invoking an individual step. It returns requests for agent or human handling to the host; it does not execute a complete workflow independently of that host.

Operation history preserves generation outcomes and errors. The source view labels versions Not yet evaluated. No emails or external reports are sent. The user must explicitly start subsequent work; nothing is published as a production agent automatically.

## Current limits

The latest 20 plans, code versions, and operations are listed. General repository connection, IDE edit import, and an in-browser editor are outside demo scope. Evaluation, repair, complete workflow execution, and runtime human responses are planned but are not delivered by this feature. Hosted artifact access requires private shared storage; local development artifacts remain on the machine that created them.

Method suggestions run while the request is open; generation runs durably in the background. The UI prevents starting competing operations but does not require a new AI recommendation before an engineer approves a revised plan. Model suggestions and source generation can fail; neither failure modifies the frozen customer process.
