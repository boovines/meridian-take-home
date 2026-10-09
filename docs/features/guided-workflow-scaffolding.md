# Guided workflow scaffolding

The process expert can turn unstructured thoughts into an initial whiteboard through a persistent note, a scoping conversation and an explicitly approved graph preview. Start on the normal workflow page, using the circular note button above the canvas zoom controls. There is no built-in dictation; external dictation tools can enter ordinary text.

## Notes and conversation

The note opens in a draggable floating window that stays fixed while the canvas moves or zooms. Its position is remembered on this device. Expand it for a split workspace with the original notes beside the conversation or preview; small screens use a full-screen surface. The window can be moved with the drag handle or its arrow keys. Escape, the close button or the canvas toggle hides the note without deleting it. Full-screen mode traps focus; closing returns focus to the canvas toggle.

Notes autosave after a short pause, with saved/saving/error feedback. They do not automatically send anything to the agent or change the workflow. Failed saves preserve local text, and reopening offers recovery when an unsaved local draft differs from the database. A conflicting save shows the saved version and requires an explicit choice to keep and save local text or use the saved note. Original notes remain separate from AI summaries.

“Help build workflow” sends a snapshot of the saved note. The agent asks consequential questions about the trigger, outcome, steps, routing, human decisions and exceptions. The expert may type freely, accept recommendations or state what is unknown. The scope summarizes known behavior, assumptions and unresolved questions. Structural uncertainty prevents preview generation; nonstructural detail can remain explicitly unresolved for normal review. Readiness is based on all six scope areas being populated and no structural blockers remaining; the quality of those judgments still depends on the model and expert confirmation.

Updated note text is not silently substituted into a pending model request. Select “Use updated notes” to incorporate it, cancel obsolete pending work and reassess scope. Generation and application are disabled until the current saved note has been incorporated. Replies and requested revisions produce new immutable scope versions. If a response is lost, retrying unchanged input keeps the original request key and revisions even after a session refresh, preventing duplicate interview turns and model calls. Queued/running work survives closing the browser. Cancel fences late responses; failure or timeout preserves notes, conversation and prior previews.

## Preview and apply

Select “Generate preview” to confirm the displayed scope and assumptions. The preview is a real navigable graph using the existing seven block types, routes, loops and paired parallel sections. Select a block or use “Inspect a block” to read complete instructions. The desired outcome and unresolved review questions are visible alongside the graph.

Request changes through the conversation, then confirm the revised scope and generate another preview. Previous successful previews remain accessible through preview history, including after a failed revision. Only a current validated preview can be applied.

Apply saves the entire graph and the displayed desired outcome atomically. It never overwrites existing active blocks or connections, and it rejects stale scope, note and workflow revisions. Duplicate application requests cannot duplicate the graph. The canvas updates in place and fits the newly applied graph once. Ordinary editing continues to use the existing explicit Save buttons.

Initial generation is available only before this session's first application, on an empty draft board. Adding blocks manually while interviewing blocks application without deleting the notes or conversation. Existing boards can still use the note, but this feature does not extend or replace their graph. Removing an already-applied graph does not reset the initial-generation session.

## Review and handoff

After application the process is an editable draft marked Not reviewed. Review does not start automatically. The expert inspects or edits the canvas, opens Review & comments and selects Review draft.

Unresolved questions remain in the accepted scope and relevant generated instructions. They become ordinary anchored findings when a real review prepares its input; publication also checks for missing transfers. The reviewer sees those findings and can follow up, but omitting them does not remove them. Retries and subsequent reviews reuse the same source-linked finding and preserve its disposition. Cancelled or failed review runs do not count as completed reviews; their transferred questions remain available. Deleting all referenced items retains the question with the existing target-deleted disposition.

Freeze requires a completed review of content at or after initial application, no open findings or untransferred questions, and valid structure. An older completed review cannot bypass this rule via the changed-content acknowledgment. After a qualifying review, ordinary later-edit acknowledgment rules still apply. The frozen handoff includes the accepted scope, preview, element mapping, application revision and linked review evidence. Engineering consumes the saved blocks, not an inferred interpretation of mutable scratch notes.

Notes/history remain accessible after apply; editing notes never implicitly changes blocks. Reviewing and frozen boards make note mutation controls read-only, consistently with the board lock. This demo uses the application's existing access model; there is no separate scoping role or permission system.

## Limits and failure behavior

- Notes accept up to 50,000 characters; a reply up to 20,000. Combined model context is bounded at 180 KB. The app rejects oversized input rather than silently truncating expert requirements.
- Generated graphs are limited to 40 blocks and 80 connections, with up to 15 unresolved questions. Existing graph validation rejects unsupported overlap/nesting of parallel regions and invalid routes.
- One model operation is active per workflow-scoping session. Calls and retries are bounded; an operation expires after five minutes. The UI can recover and retry using saved notes.
- Browser-local recovery and position preferences depend on browser storage. Database-saved notes, conversation and previews survive independently. Unsaved edits trigger navigation warnings where supported.
- Scoping produces a reviewed-by-human initial proposal, not proven executable software. Normal AI review, freeze, engineering and evaluation remain separate stages.

## Verification

The [approved implementation specification](../product/guided-workflow-scaffolding-spec.md) records the intended contract. Focused service tests cover note conflicts, atomic/idempotent application, stale and nonempty boards, late operations, immutable history, unresolved-question transfer and the post-apply freeze gate. Provider-contract tests verify structured schemas and input snapshots; Temporal tests exercise retry and cancellation. Browser journeys cover note editing/recovery, movement, expansion/focus, mobile reduced-motion behavior, preview inspection, application without navigation and normal review.

Live-model smoke verification is separate from required CI and does not establish repeatability across arbitrary processes. See the dated [implementation evidence](../implementation-status.md) for actual results.

The model's preview contract requires an Otherwise path to have no condition. Conditional paths remain explicit; the app does not silently delete a generated condition to make an invalid preview pass validation. Live verification includes a human-approval loop and preserved unresolved review questions.
