# Guided workflow scaffolding

Status: approved implementation specification. Implemented on the guided-workflow-scaffolding branch; see the [feature contract](../features/guided-workflow-scaffolding.md) for behavior and verification. October 9, 2026.

This extends the [whiteboard product requirements](whiteboard.md) with an explicitly approved initial-generation path. Existing authoring, review and freeze contracts remain authoritative outside the changes described here.

## Purpose and boundaries

A process expert can collect unstructured thoughts in a persistent canvas note, work through a short AI scoping interview, and approve an initial connected workflow. The expert owns the resulting process. Initial generation does not substitute for the normal AI review or authorize execution.

Initial generation is available only on an empty draft board. It uses the existing Trigger, Information, Task, Check, Human Handoff, Human Approval and Outcome block types. It may propose the desired outcome alongside the graph. Existing workflows are not rewritten or extended through this feature.

Built-in dictation, document ingestion, new block types, runtime execution and engineering generation are outside this version. The editor accepts ordinary text input, including text inserted by external dictation software such as Wispr Flow. Do not add a microphone control.

## Note and conversation experience

One persistent note belongs to each workflow. A circular note button sits immediately above the bottom-left canvas zoom/fit controls. It opens a draggable floating window fixed to the viewport, outside the canvas pan/zoom transform. The note is not an executable graph node and has no connections.

When the note is open, the toggle exposes the close icon on hover/focus and hides the window on activation. Closing never deletes content. Give the control a stable accessible name reflecting its action, a tooltip and a clear touch target; hover must not be required to understand or activate it. Remember the window position as a per-workflow local preference and clamp it to the visible viewport when reopening or resizing.

The floating window can expand into a full-screen editor. Preserve text, scroll position and pending answers across floating/full-screen transitions. Restore focus to the invoking control on close, support Escape, and prevent drag handles from interfering with editing or buttons. On small screens use the expanded surface rather than an off-screen floating window.

The surface contains the original note, a distinct interview conversation, the current scope summary and the latest graph preview when available. Preserve the raw note rather than replacing it with an AI summary. Use progressive disclosure so an expert can begin with a plain editor and discover the interview through an explicit “Help build workflow” action.

Autosave the note with a short debounce and visible Saving, Saved and failure states. Flush pending changes before sending them to AI; an unsaved or conflicted note cannot silently become the model input. Preserve a recoverable local draft on network failure, including when the window is hidden. Use revision checks for multi-tab edits and offer explicit recovery instead of last-write-wins. Autosaving a note does not change the workflow's semantic revision or trigger an AI request. Existing explicit Save buttons for block instructions remain unchanged.

After applying the graph, the note, interview and preview history remain available. Note edits on an editable draft do not implicitly alter blocks. Initial generation is disabled while the board contains active blocks or connections. During review and after freeze, history remains readable and mutation controls follow the board's existing editing lock.

During implementation use jhouui to generate and inspect three live variants of this note/interview surface, choose the strongest without another selection round, apply it and remove picker scaffolding. Preserve the agreed control placement and floating/full-screen behavior across variants. Evaluate readability, focus, editing space and the transition from notes to conversation to preview; respect reduced-motion preferences.

## Interview and stopping rule

The interview skill says to continue until complete but supplies no measurable stopping criterion. For this feature, readiness means enough confirmed information exists to construct a valid initial state machine without inventing consequential behavior:

- The trigger and scope of one workflow run are clear.
- The desired outcome and observable completion condition are clear.
- Major steps, needed information and ordering are clear.
- Decisions, branches, loops and parallel waits are clear where applicable.
- Required human approvals or handoffs and their continuation paths are clear.
- Known exceptions are either represented or explicitly identified as unresolved detail.

Ask about consequential ambiguity and contradictions before proposing a graph. Prefer one consequential question per turn; group closely related questions when they share context. Offer a recommendation with reasoning where useful, allow free-form answers, and accept “I don't know” without repeatedly asking the same question.

Distinguish structural blockers from detail gaps. An unknown approval route prevents readiness. A missing threshold can remain an explicit unresolved detail only when the confirmed graph can faithfully represent the uncertainty without pretending to have executable decision semantics. Do not fill gaps with plausible values or silently treat a guess as a confirmed requirement.

Maintain a versioned summary of confirmed requirements, minor assumptions requiring confirmation, and unresolved detail questions. Once the readiness criteria are met, show that summary and offer “Generate preview.” This is an explicit expert action confirming the displayed scope and assumptions; the agent does not continue interviewing indefinitely or apply blocks automatically. If structural blockers remain, explain what prevents preview generation.

Edits to the note do not silently alter an in-flight request's input. An explicit “Use updated notes” action incorporates the latest saved note, re-evaluates readiness and invalidates obsolete unapplied previews. Keep prior conversation and preview versions as history. New interview answers or requested preview revisions likewise fence older operations from publishing as the current result.

## Preview and application

Generate a structured graph using temporary stable element keys, supported node/config contracts, connection conditions, split modes and paired merges. Validate it with the existing graph rules. Use deterministic layout so the preview is a real navigable graph rather than an image or a prose-only list. Display the proposed desired outcome and make block instructions inspectable.

The expert can request conversational revisions before applying. Keep the last successful preview visible if a revision request fails. Validate every replacement preview; do not expose an invalid partial graph as ready to apply. The expert approves the entire initial graph with one Apply action, rather than accepting disconnected blocks individually.

Apply runs in one transaction and checks that:

1. The workflow is still an editable draft and its expected revision matches.
2. The active graph is still empty, including active connections.
3. The selected scope/preview version is current and has not already been superseded.
4. The proposed graph and desired outcome pass the current contracts and structural validator.

Create all nodes and connections with server-generated IDs, map temporary keys and paired-merge references, persist provenance and unresolved-item anchors, and update the desired outcome exactly as approved. Increment workflow semantic revision once for the compound change. Do not call individual add-node APIs in a client loop. An idempotency key makes retries return the same applied result rather than duplicating blocks.

Return the saved board to the client and reconcile it without a page reload. Fit the new graph deliberately once after successful application; ordinary saves retain the viewport. If another tab or person adds content first, block application, keep all scoping work, and explain that initial generation requires an empty board. Never clear existing content automatically.

## Normal review remains mandatory

After application, the graph is an ordinary editable draft with a visible Not reviewed state. Do not start review automatically. The expert may inspect or edit the scaffold and then select the existing Review draft action.

Unresolved detail questions appear in the relevant generated block instructions and the accepted scope summary. Persist each question with a stable source key and mapped graph anchors. The normal review must carry these forward as findings requiring an explicit normal disposition; their presence in a prompt alone is insufficient because a provider could omit them.

Integrate unresolved items into publication of a real review run, using that review's actual origin ID and existing finding/thread/message contracts. Deduplicate against already linked findings across retries and subsequent reviews. Preserve normal resolution, rejection-with-reason, reopening and deleted-anchor behavior; never silently close a scoping question because generation finished or a later model omitted it. Workflow-level questions may use workflow-level findings rather than artificial nodes. Review cancellation/failure retains pending obligations for a later run.

Record the content revision produced by scaffold application. Freeze must require a completed review that analyzed at least that revision. A historical review from before the scaffold was applied cannot satisfy this requirement, even with the existing changed-since-review acknowledgment. Once a qualifying review exists, retain the ordinary handling of later edits and all existing structural/open-finding freeze gates. Pending scoping obligations that have not yet been transferred to real findings must also prevent freeze.

Freeze captures the accepted scope/preview version identifier, application provenance and resulting review evidence alongside the authoritative graph. Mutable raw notes are not executable requirements. Preserve their history separately; engineering must not need to reconstruct block behavior from the interview transcript.

## Persistence and orchestration

Use dedicated workflow-scoping persistence rather than encoding the note as a node or treating the interview as a review run. Proposed migrations should establish these concrete responsibilities:

| Record | Responsibility |
| --- | --- |
| Workflow scoping session | One per workflow; current raw note and revision, lifecycle, current confirmed scope/preview references and applied revision. |
| Scoping messages | Ordered, immutable expert/agent conversation with request keys and source operation references. |
| Scope and preview versions | Immutable input note revision, confirmed summary, assumptions, unresolved items, structured graph and provenance. |
| Scoping operations | Durable interview/generation work, input snapshot, idempotency key, status, version fencing, cancellation and failure information. |
| Scoping review obligations | Stable question keys, applied graph anchors and links to ordinary review findings/dispositions. |

Exact table names can follow repository conventions during implementation. Enforce same-workflow ownership, valid version references and uniqueness in the database. Keep note revision separate from graph content revision. Record before/after operation outcomes sufficiently to explain what was generated, confirmed and applied.

Existing discussion constraints tie non-note threads to real review runs; do not create orphan finding threads or fake successful reviews. Existing engineering workflow jobs require an implementation plan and have a fixed operation-kind contract; do not create a fake plan just to run a scoping interview.

Reuse the established Temporal dispatch/outbox pattern with a dedicated scoping operation contract. Allow one active model operation per session, persist before dispatch, and recover progress after closing/reopening the browser. Use bounded provider calls/retries and a visible terminal failure with retry. Cancellation and version checks prevent late completions from replacing newer scope or previews. No database row lock remains held during a model call. A model failure cannot partially apply graph changes.

Treat note content as requirements data, not authority to bypass the product's approval, empty-board, schema or review gates. Provider output is validated structured data and never directly executed.

## Module and API boundaries

Keep thin HTTP handlers under `app/src/app/api/workflows/[id]`, transactional services under `app/src/server/scoping`, pure contracts/readiness and graph-mapping rules under `app/src/domain`, and note/interview UI under a dedicated feature directory in `app/src/components`. Share row locking and graph reads through `server/workflows/store.ts`; provider clients stay in `server/integrations`, and Temporal workflows stay deterministic.

Provide feature-scoped operations to read session/history, save the versioned note, submit an interview answer, incorporate updated notes, generate/revise a preview, inspect/cancel an operation and apply a specific preview. Mutations accept expected revisions and request keys where replay is possible. Return saved records or operation IDs for client reconciliation, not instructions to reload the page. Reuse the existing review and freeze entry points for the final gate.

Do not introduce a new main workflow state: scoping is a separate lifecycle while the board remains draft. Update the application module map and implemented feature contract when code lands; until then this document records intended behavior only.

## Verification and delivery

Required fixture-based checks during implementation:

- Readiness does not invent missing branch/approval behavior; confirmed minor assumptions and safe detail gaps are represented distinctly.
- Invalid model graph/config output cannot become an applicable preview; valid loops and paired parallel sections survive mapping and layout.
- Notes and interview/preview history survive reopening, hiding, expanding, failures and cancellation; autosave conflicts preserve recoverable expert text.
- A late operation cannot supersede a newer note/scope/preview, and duplicate requests cannot create duplicate turns or graphs.
- Applying is atomic and idempotent; stale versions, nonempty graphs, reviewing/frozen boards and concurrent edits reject safely.
- Unresolved questions become anchored ordinary findings even when provider output omits them; retries do not duplicate findings or erase dispositions.
- Old completed reviews cannot authorize freeze after scaffold application; cancelled/failed reviews do not satisfy the gate; a completed post-apply review plus resolved findings and valid structure can.
- Browser journeys exercise the note toggle, drag bounds, full-screen/focus behavior, keyboard/touch access, interview, preview revision, apply without reload and explicit normal review.

Run lint, typecheck, relevant business-rule/database/browser tests, production build, worker checks and documentation validation as appropriate. Keep required CI independent of live model credentials. Report fixture results separately from any live model smoke test; neither static checks nor a successful interview alone proves generated workflows execute correctly.

Implement persistence/contracts and fixture-backed service flow first, then the note/interview/preview UI, then ordinary-review transfer and freeze safeguards, and finally the complete browser journey. Do not ship Apply without the review safeguards. Base implementation PRs on the most logical dependency branch, preferably current main when dependencies are merged; do not automatically stack on the latest unrelated open PR.

All product choices from the interview are settled. UI variants, precise debounce timing and final internal record names are implementation decisions within this contract, not reasons for another approval round.
