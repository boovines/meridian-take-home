# Feature: Whiteboard

Owner: Justin Hou · Updated October 7, 2026

Revised from the original [Whiteboard PRD](https://docs.google.com/document/d/1ARjmPNDBDeczJDOFiMdOHB7r4_Z6-9CQCb2Mm7PHjiA/edit?tab=t.t8uhdbuizy7d) and the requirements/schema interview. This local revision supersedes the original's conflicting scope; the Google Docs tab has not been updated because it is view-only in the current account.

## Motivation

### Problem: Process mapping

A process owner knows how work happens but needs help turning that knowledge into an implementable workflow. The whiteboard lets a nontechnical customer independently map the process, clarify consequential gaps, remove unnecessary steps, and freeze a stable handoff to an engineer. Import receiving is the demonstration; the primitives and review flow must work for other processes too.

### Example workflow: Pre-arrival document review

The owner maps how existing shipment emails and attachments are grouped using the container number or MAWB number. Each distinct invoice is checked for five required fields on each good: HTS, FDA product code, ANDA, registration number, and NDC. One missing field fails a good and its invoice; two missing fields on one good still count as one failed good, with two discrepancy details. Each distinct batch is checked against its Certificate of Analysis. Missing or mismatched certificates produce batch discrepancies.

The process ends with shipment totals and a report preview. The demo explicitly selects an existing email or shipment number; it does not monitor Gmail or send the report. Supplied ground truth defines the verified counts. Mismatched-invoice scoring is excluded, without removing batch/CoA matching. Do not infer that every certificate discrepancy also fails an invoice unless the verified requirements establish that relationship.

## Requirements/Acceptance Criteria

Customers can create, name, save, and reopen multiple independent workflows. Each has a plain-language desired outcome and a canvas containing Trigger, Information, Task, Check, Human Handoff, Human Approval, and Outcome blocks. Instructions describe inputs, checks, and expected behavior without requiring a technical form. Implementation-relevant answers must end up in the workflow definition; the coding agent should not reconstruct requirements from comments.

Connections carry plain-language conditions and support loops. At a split, the customer chooses one matching path or parallel paths. Parallel splits have an explicitly paired wait-for-all merge; overlapping parallel sections are deferred. Exclusive routing requires exactly one match, uses an optional Otherwise connection for no matches, and reports an error on multiple matches.

Review draft checks both ambiguity and simplification opportunities. It explains why a step may not contribute to the desired outcome, considers exceptions and required approvals, and asks when its purpose is unclear. AI suggests; the customer owns the process. AI never adds, removes, or reconnects graph elements. Customers manually implement graph changes or reject them with a reason.

Freeze requires at least one completed review, no open AI findings, and valid structure: exactly one Trigger, valid endpoints, every active block reachable from the Trigger, explicit split modes, and valid parallel pairing. Drafts may remain incomplete. If content changed after review, the customer may acknowledge a warning and freeze without another review. The demo demonstrates two review rounds, separately from the product's one-review minimum.

Freeze atomically captures an immutable specification and locks the board. No revisions after handoff or permissions system are required for the demo. Resolved customer decisions settle AI findings; structural checks remain independent of AI judgment.

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
