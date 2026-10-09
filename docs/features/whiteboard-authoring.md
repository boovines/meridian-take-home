# Using the current whiteboard

Create a workflow from the library, give it a name, and describe the outcome it should achieve. Add blocks and write instructions in your own words. Connect blocks by their dots or choose a next block in the detail panel; click a connection to explain when that path is taken.

The current surfaces are the workflow library (`/`), creation dialog, and board (`/workflows/:id`) with block, connection, and workflow detail panels. Everyone using the protected demo workspace has the same capabilities.

Save persists detail changes. Moving a block saves its position. If another tab has edited the same item, compare the saved version with your preserved draft before retrying. Removing a block also removes its paths and clears its merge pairing.

Parallel and conditional settings describe the process. [Review and freeze](review-handoff.md) validate its readiness for handoff; [generation](engineer-generation.md) and [execution](workflow-runtime.md) happen in the engineer workspace. Editing the board itself does not execute work or send messages.

## Implementation contract

This contract covers draft authoring. Review, handoff and execution have separate contracts linked above.

### Surfaces and access

The workflow library at `/` lists the most recently updated workflows. Create workflow opens a dialog with a required name and an optional desired outcome. Creating it opens `/workflows/:id`. Selecting a saved workflow reopens its board. The current demo has one shared workspace and no organization or role management; hosted access protection is required before exposing it outside local development.

### Authoring

The board shows a block palette, a movable and zoomable canvas, and a detail panel for the selected block or connection. Workflow details edits the name and the outcome the process should accomplish. Explicit Save actions persist text. A save-status indicator identifies unsaved panel edits.

Customers can add seven kinds of block: Trigger, Information, Task, Check, Human handoff, Human approval, and Outcome. Each has a name and plain-language instructions, with contextual prompts explaining the information to provide. Adding a block saves it immediately. Successful additions, moves, connections and detail saves apply the returned database record directly to the mounted board; ordinary saves do not refetch the board or reviews. Opening or closing panels preserves pan and zoom. The initial view fits the board, and the canvas Fit view control remains available to recenter it. Click a palette item or drag it onto the canvas; dropped coordinates account for the current pan and zoom. Moving a block saves its position when the drag ends. After a detail save, the button shows a checkmark and Saved until the fields change again.

Connect a bottom dot to another block's top dot, or choose a next block in the detail panel. Return paths and incomplete drafts are allowed. Clicking a connection opens its condition editor. Conditions are plain language. A connection can be marked Otherwise; this clears its condition. Each source block can have only one Otherwise connection.

A block can explicitly select Follow one matching path or Run both paths. A merge chooses the parallel split whose branches it will wait for. The paired split must be another active block in this workflow. A split can have only one paired merge. These settings describe the process; draft authoring does not execute it. Freeze separately validates that the whole graph is ready for handoff.

### Changes, removal, and conflicts

Save rejects stale changes when another tab has changed the same item. The draft text remains in the form. For detail saves, the panel shows the saved version and lets the customer deliberately use its revision before saving their own text again. Changes to unrelated blocks do not cause a false text conflict. Moving the selected block advances its row revision, but the open editor safely uses that newer revision only if all process fields still match its saved baseline. Unsaved text remains intact; actual changed instructions still require comparison. Canvas mutations are disabled while an inspector request is saving. Layout changes do not count as changed business requirements.

Removing a block asks for confirmation, removes its connected paths, and clears merge references to it. The removed content remains in history, but restore and undo are not exposed in the current interface. Removing a connection takes effect immediately. Changing panels with unsaved detail text asks whether to discard it; browser unload also warns. Internal navigation to the workflow library currently does not show that discard warning.

Deletions and review actions refresh authoritative state in place to include related paths, merge pairings and findings. Older in-flight board reads cannot replace a newer acknowledged mutation. Errors remain visible and reload does not silently replace unsaved panel text. A failed drag-save can leave the local position visible until reload; it is not reported as saved. Draft creation does not send email, execute work, or start an agent.

### Limits and remaining work

- Names are required for workflows and limited to 200 characters. Block names can remain empty in a draft. Instructions accept up to 20,000 characters; desired outcomes up to 10,000; conditions up to 5,000.
- A board cannot reference another board's blocks or connections. Creation, editing, and removal are rejected once the board is reviewing or frozen.
- The library shows up to 100 workflows; pagination, search, collaboration, and ownership controls are not implemented.
- The canvas primarily targets laptop and desktop use. Narrow layouts retain the block palette as icons and overlay the detail panel.
- Product scope and future requirements remain in the [whiteboard PRD](../product/whiteboard.md). Implemented review, generation and evaluation behavior is documented in the adjacent feature contracts.

## Optional process context

**Process context · Optional** opens a separate evidence attachment from the whiteboard toolbar. Export 1–50 selected moments with DeepShelves 2.0's `deepshelves-cli timeline --days 1 --limit 50`, then import the JSON file or paste its output. Preview each moment, select the relevant ones, name the recording and save. Newly imported moments start unselected. No desktop archive is queried by the web server, and no model is called by importing or saving. This works with local and hosted whiteboards.

This attachment contains sampled screen text, app names, titles, timestamps and source moment IDs. It is not a complete computer-action recording; screenshots, explicit URL fields, image paths and unknown fields are excluded. Visible text may still contain sensitive content. The panel explains that saving persists selected text, and review/replies send it to the configured model provider. The import is bounded to 100 KB of source JSON and 50 KB of normalized context, with unique IDs and valid timestamps. Only one named recording is attached at a time; saving an import replaces it.

Context is optional and separate from workflow blocks. AI receives it as `raw_process_data`, explicitly untrusted observational evidence, to inform clarification and review. It cannot authorize actions or silently change requirements. Expert-approved block edits remain the source of executable behavior. With no attachment, the existing review input and prompt are unchanged.

Saved context survives reopening. Changes use a separate revision and the shared workflow lock; stale saves preserve the local selection and offer an explicit reload. Unsaved changes warn before closing. Changing context increments the workflow content revision, requiring fresh review or the existing acknowledgment at freeze. Active review and frozen workflows prevent mutation. Removal excludes the attachment from future review; earlier sealed review snapshots retain their evidence. Freeze stores current context in `review_evidence`, outside the executable graph; the current generation path does not receive raw observations as requirements. No new freeze requirement is introduced.

Verification: `tests/process-context.test.ts` covers sanitized import, bounds, revision conflicts, unchanged graphs, review snapshots, removal and frozen evidence separation. Provider tests check the explicit raw-data boundary; browser checks cover preview, opt-in selection, saving/reopening and removal. These checks do not establish live model interpretation quality.
