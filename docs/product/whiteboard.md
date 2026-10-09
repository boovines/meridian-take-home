# Feature: Whiteboard

Owner: Justin Hou · Updated October 7, 2026

Revised from the original [Whiteboard PRD](https://docs.google.com/document/d/1ARjmPNDBDeczJDOFiMdOHB7r4_Z6-9CQCb2Mm7PHjiA/edit?tab=t.t8uhdbuizy7d) and the requirements/schema interview. This local revision supersedes the original's conflicting scope; the Google Docs tab has not been updated because it is view-only in the current account.

## Motivation

### Problem: Process mapping

A process owner knows how work happens but needs help turning that knowledge into an implementable workflow. The whiteboard lets a nontechnical customer independently map the process, clarify consequential gaps, remove unnecessary steps, and freeze a stable handoff to an engineer. Import receiving is the demonstration; the primitives and review flow must work for other processes too.

### Example workflow: Pre-arrival document review

The owner maps how existing shipment emails and attachments are grouped using the container number or MAWB number. Each distinct invoice is checked for five required fields on each good: HTS, FDA product code, ANDA, registration number, and NDC. One missing field fails a good and its invoice; two missing fields on one good still count as one failed good, with two discrepancy details. Each distinct batch is checked against its Certificate of Analysis. Missing or mismatched certificates produce batch discrepancies.

The process ends with shipment totals and a report preview. The demo explicitly selects an existing email or shipment number; it does not monitor Gmail or send the report. Supplied ground truth defines the verified counts. Mismatched-invoice scoring is excluded, without removing batch/CoA matching. Do not infer that every certificate discrepancy also fails an invoice unless the verified requirements establish that relationship.

The approved [guided scaffolding specification](guided-workflow-scaffolding-spec.md) extends these requirements with initial graph generation on empty boards. That scoped, explicit approval flow is an exception to the manual graph-authoring rule below; it still requires normal review before freeze as detailed in the [implemented feature contract](../features/guided-workflow-scaffolding.md).

## Requirements/Acceptance Criteria

Customers can create, name, save, and reopen multiple independent workflows. Each has a plain-language desired outcome and a canvas containing Trigger, Information, Task, Check, Human Handoff, Human Approval, and Outcome blocks. Instructions describe inputs, checks, and expected behavior without requiring a technical form. Implementation-relevant answers must end up in the workflow definition; the coding agent should not reconstruct requirements from comments.

Connections carry plain-language conditions and support loops. At a split, the customer chooses one matching path or parallel paths. Parallel splits have an explicitly paired wait-for-all merge; overlapping parallel sections are deferred. Exclusive routing requires exactly one match, uses an optional Otherwise connection for no matches, and reports an error on multiple matches.

Review draft checks both ambiguity and simplification opportunities. It explains why a step may not contribute to the desired outcome, considers exceptions and required approvals, and asks when its purpose is unclear. AI suggests; the customer owns the process. AI never adds, removes, or reconnects graph elements. Customers manually implement graph changes or reject them with a reason.

Freeze requires at least one completed review, no open AI findings, and valid structure: exactly one Trigger, valid endpoints, every active block reachable from the Trigger, explicit split modes, and valid parallel pairing. Drafts may remain incomplete. If content changed after review, the customer may acknowledge a warning and freeze without another review. The demo demonstrates two review rounds, separately from the product's one-review minimum.

Freeze atomically captures an immutable specification and locks the board. Further changes require an explicit revision draft and a fresh review; a permissions system remains outside scope. Resolved customer decisions settle AI findings; structural checks remain independent of AI judgment.

## Product Experience

The app starts with a workflow list and Create action. Opening a workflow shows its name, desired outcome, and an Excalidraw-style canvas. A collapsible block palette, pan/select/connect/comment controls, and zoom preserve the original interface direction. Selecting a block opens its instructions with prompts such as “What information do you use?” and “What happens if it fails?” Selecting a connection edits its condition. Splits and their paired merges have explicit, readable controls.

Review draft replaces the original preimplementation Test button. It temporarily locks canvas editing and offers Cancel. A clarification panel asks consequential questions; if the desired outcome is missing, the customer supplies or confirms it before review judges steps unnecessary. Findings appear as badges and anchored threads on blocks, connections, or the workflow. The selected thread shows the concern, explanation, and customer response. Cancelling restores editing and prevents late review results from changing the draft.

For an allowed detail clarification, show a before/after preview and Apply and resolve. Save the approved detail and close the finding together; reject the entire action if the block or finding changed meanwhile. Suggestions that introduce actions or change routing remain manual, even if they could be phrased as extra instructions. Resolution choices explain whether the customer updated the workflow, clarified it, or chose no change. Require a brief answer or reason for closure without an edit; AI does not judge that reason as a freeze gate.

Customers can reopen findings before freeze, preserving previous decisions. AI cannot reopen them; materially changed context can produce a new linked finding explaining what changed. Deleting a finding's sole referenced block automatically closes it with the deletion reason and preserves context. Ordinary customer comment threads do not block freeze. Replies remain part of their thread, not additional blockers.

Freeze shows concrete fixes if blocked and an acknowledgment warning for unreviewed content. The resulting read-only board identifies the specification handed to engineering. Save state and failures remain visible; a stale save preserves the user's unsaved text for recovery instead of silently overwriting newer work.

## Tech Stack

React and TypeScript with Next.js provide the canvas and API. Supabase/Postgres stores definitions, discussions, reviews, and frozen specifications. An LLM service performs clarification and review. React Flow supplies the canvas and OpenAI supplies the reviewer. Optional selected DeepShelves screen-context imports can inform AI review; they do not create graph elements or execute recorded work. General MCP source panels, company-document ingestion, SOP-to-canvas generation, and automated process mining are outside the core demo. Gmail belongs to the execution feature.

## Data Model

`workflows` stores identity, name, desired outcome, draft/reviewing/frozen state, and edit/content revisions. `nodes` and `connections` are independently editable rows owned by a workflow. Nodes store type, title, instructions, validated type-specific config, position, and split/merge settings; connections store endpoints, conditions, and the Otherwise flag. Same-workflow foreign keys prevent cross-board links. Soft deletion preserves historical references.

`review_runs` records status, model/settings, and the exact content analyzed. `discussion_threads` distinguishes findings, notes, and clarification threads, with disposition and proposed detail edits. `discussion_messages` preserves replies and decision events using same-thread parent IDs. `thread_anchors` supports multiple targets; workflow-level findings need no artificial node. `frozen_specs` stores the complete immutable graph and review evidence consumed by engineering.

Separate rows allow targeted edits and indexed board/edge lookup. Immutable frozen JSON is appropriate because handoff consumes the whole definition. Short transactions coordinate review, edits, and freeze; per-record revisions reject stale edits, while semantic revisions exclude layout-only movement. No LLM call holds a database transaction open. Executable fields, constraints and indexes are in migrations 001–004; the canvas/review schema specifications preserve planning context.

## API Endpoints

Implemented API contracts: Mutations validate workflow state and expected revisions; compound changes are transactional.

| Endpoint | Purpose |
| --- | --- |
| `GET/POST /api/workflows` | List or create independently saved workflows. |
| `GET/PATCH /api/workflows/:id` | Load the board or update metadata; exclude wholesale graph replacement. |
| `POST /api/workflows/:id/nodes` and `/connections` | Create primitives or routes. |
| `PATCH/DELETE /api/workflows/:id/nodes/:nodeId` and `/connections/:connectionId` | Update or soft-delete a specific element. |
| `POST /api/workflows/:id/reviews` | Start review against a saved content revision. |
| `GET /api/workflows/:id/reviews`; `POST /api/workflows/:id/reviews/:reviewId/goal` or `/cancel` | Inspect reviews, answer outcome clarification or cancel. |
| `POST /api/workflows/:id/threads`; `POST /api/workflows/:id/threads/:threadId/messages` | Create a customer note or append a reply. |
| `POST /api/workflows/:id/threads/:threadId/actions` | Resolve, reject, reopen or apply an approved detail edit with revision checks. |
| `GET/POST /api/workflows/:id/freeze` | Inspect freeze readiness or validate and freeze once. The engineer workspace reads the saved immutable handoff. |

Stale saves return a conflict with the current revision. Review results and freeze state survive refresh. The [architecture](../architecture/overview.md), [data-model decision audit](../architecture/data-model.md), [verification plan](../verification.md), and [future scope](../../README.md#future-work-outside-demo-scope) cover shared design and deferred work. The implemented behavior and failure states are detailed in the [feature contracts](../README.md#implemented-features).

## Proposed extension: engineer-requested process revisions

Status: implemented in the process-revisions branch; live deployment and expert approval remain pending. This extension replaces the earlier exclusion of post-handoff revisions. It does not make frozen specifications mutable or permit autonomous repair to change business rules.

### Request and approve changes

Add **Request changes** on the Implementation tab beside **Recommend methods with AI** (renamed from Suggest methods). The engineer writes what is underspecified or should change, optionally selects affected blocks, and sends the request. Persist their original wording, source frozen version and linked targets. A request can address multiple blocks or the workflow outcome; it is clearly authored by the engineer, even if AI helps translate it into proposed edits. Sending it does not edit or unlock the approved process.

The whiteboard shows an **Engineer requested changes** alert linking to the existing Review Conversation. The process expert can discuss or reject the request with a reason while the board remains frozen. They explicitly choose **Start revision** to open the next editable draft, initialized from the current frozen version. Show that they are editing draft v2 based on frozen v1. Keep at most one active revision draft; another request joins that revision rather than creating competing copies.

Use the existing conversation-to-proposal flow for changes to block titles and instructions. The process expert sees before/after wording, can edit it, and independently accepts or rejects each affected block's proposal. No AI-written change applies without their action. Update the workflow-level desired outcome through its normal editor when needed. Proposed additions, deletions or connections remain explicit manual canvas edits with clear instructions in the conversation; neither engineer requests nor AI silently rewrite the graph. Stale suggestions require regeneration or reconciliation rather than overwriting a newer draft.

Resolve each request with recorded disposition and reasoning, including when only some edits are accepted. Accepted wording must be saved into the draft definition; a conversational answer alone does not become an executable rule. Unresolved engineer requests associated with this revision block its handoff, as do open AI findings. Historical resolved discussions remain visible without becoming new blockers.

### Revised handoff and engineer continuity

Before freezing v2, require one successfully completed AI review of that revision, explicit resolution or rejection of its requests/findings, and all existing structural checks. The existing acknowledgment for semantic edits after that revision's review remains available. A review of v1 alone cannot satisfy v2's review requirement. Freeze creates a new immutable specification, preserving both graphs and their approval history.

Engineering can continue using v1 during drafting, including existing runs and repairs. Show **Revision in progress** and the frozen version being used. Draft edits must never alter runtime reads of the v1 graph. After v2 is frozen, make v2 the default engineering context while retaining an explicit version selector for v1 history and work. Existing operations finish against their original specification; they cannot publish code or defaults as though they belonged to v2. The existing limit of one expensive operation per workflow remains unless deliberately redesigned.

Create a new draft implementation plan for v2. Carry forward method choices for unchanged steps, but require fresh approval; changed or new steps require fresh choices/recommendations. “Unchanged” must account for executable requirements, routing and relevant dependencies, not only matching titles; position changes alone should not invalidate a choice. Customer-required human steps stay fixed. Code generation remains an explicit engineer action. V1 code and results must not appear to implement v2, and v2 cannot run until it has an approved plan and generated implementation.

Evaluation evidence stays tied to its original code, suite and specification. Do not transfer pass labels or confirmed baselines to v2. Existing cases can be copied into a draft suite for relevance review and verification; expected answers are never rewritten by repair. Reusable engineer clarifications remain scoped to the frozen version for which they were accepted; explicitly review relevance before adopting them into v2.

### Persistence and API design constraints

Keep `frozen_specs` append-only with workflow/version uniqueness and explicit parent lineage. The mutable canvas remains one draft working copy; preserve stable node identities across revisions where appropriate, while frozen snapshots retain historical node content and deleted elements. Track draft identity/base frozen spec separately from the current approved spec. A draft's editing state must no longer imply there is no executable frozen version.

Represent engineer requests as a distinct discussion kind or typed extension using existing messages, anchors and proposal machinery, rather than duplicating a chat system. Persist source frozen spec, target revision, status, author role, disposition, and resulting frozen spec when handed back. Scope reviews and pending findings to a revision. Database guards must permit intentional draft creation while still preventing changes to immutable snapshots and historical evidence. Node references in old plans/runs must resolve against their frozen snapshot, not current mutable node contents.

Audit all “latest plan/spec/version” queries and default-version pointers: engineering and repair must filter by the selected frozen spec. Revisit one-draft-plan constraints so a v2 plan can coexist with historical v1 plans without rewriting history. Use same-workflow foreign keys, indexed workflow/spec/status lookups, optimistic revisions and idempotent actions. Start-revision and freeze transitions need short workflow-locked transactions; no model call holds the lock. Proposed API actions are send/list change requests, start a revision, inspect a selected frozen version, and freeze that revision, reusing conversation/proposal endpoints for discussion and decisions. Final names and migrations should follow the current implementation, not introduce a second parallel schema.

### UX exploration and acceptance

Use jhouui to build and inspect three distinct live variants for the request entry, whiteboard alert and conversation entry flow, respecting current tokens and accessibility. Choose the strongest without waiting for Justin, explain the choice, and remove picker scaffolding. Preserve the established canvas and Review Conversation design. Keyboard focus, dismissal, loading, failed submission and retained text need intentional behavior.

Verify engineer submission leaves v1 unchanged; process-owner rejection needs no revision; starting a revision is idempotent; individual edits require approval and stale edits are rejected; graph edits remain manual; old conversations/reviews do not satisfy or block v2 incorrectly; and new handoff preserves v1 code/runs while creating an unapproved v2 plan. Include a browser journey from engineer request through expert edits/review to v2 handoff and regeneration. Test active v1 work completing while v2 is drafted/frozen without contaminating v2 defaults. Update implemented contracts and data-model documentation only once the behavior exists.

The motivating end-to-end example is changing import receiving from one shipment at a time to selected emails grouped into separate shipments with an aggregate report. Its execution requirements are in the [multi-shipment extension](self-healing-agent.md#proposed-extension-selected-emails-to-multiple-shipments). Implement the generic request/revision flow before wiring that example; this is more than changing the trigger's label.
