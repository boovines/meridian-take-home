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

Customers can add seven kinds of block: Trigger, Information, Task, Check, Human handoff, Human approval, and Outcome. Each has a name and plain-language instructions, with contextual prompts explaining the information to provide. Adding a block saves it immediately. Moving a block saves its position when the drag ends.

Connect a bottom dot to another block's top dot, or choose a next block in the detail panel. Return paths and incomplete drafts are allowed. Clicking a connection opens its condition editor. Conditions are plain language. A connection can be marked Otherwise; this clears its condition. Each source block can have only one Otherwise connection.

A block can explicitly select Follow one matching path or Run both paths. A merge chooses the parallel split whose branches it will wait for. The paired split must be another active block in this workflow. A split can have only one paired merge. These settings describe the process; draft authoring does not execute it. Freeze separately validates that the whole graph is ready for handoff.

### Changes, removal, and conflicts

Save rejects stale changes when another tab has changed the same item. The draft text remains in the form. For detail saves, the panel shows the saved version and lets the customer deliberately use its revision before saving their own text again. Changes to unrelated blocks do not cause a false text conflict. Layout changes do not count as changed business requirements.

Removing a block asks for confirmation, removes its connected paths, and clears merge references to it. The removed content remains in history, but restore and undo are not exposed in the current interface. Removing a connection takes effect immediately. Changing panels with unsaved detail text asks whether to discard it; browser unload also warns. Internal navigation to the workflow library currently does not show that discard warning.

Errors remain visible and reload does not silently replace unsaved panel text. A failed drag-save can leave the local position visible until reload; it is not reported as saved. Draft creation does not send email, execute work, or start an agent.

### Limits and remaining work

- Names are required for workflows and limited to 200 characters. Block names can remain empty in a draft. Instructions accept up to 20,000 characters; desired outcomes up to 10,000; conditions up to 5,000.
- A board cannot reference another board's blocks or connections. Creation, editing, and removal are rejected once the board is reviewing or frozen.
- The library shows up to 100 workflows; pagination, search, collaboration, and ownership controls are not implemented.
- The canvas primarily targets laptop and desktop use. Narrow layouts retain the block palette as icons and overlay the detail panel.
- Product scope and future requirements remain in the [whiteboard PRD](../product/whiteboard.md). Implemented review, generation and evaluation behavior is documented in the adjacent feature contracts.
