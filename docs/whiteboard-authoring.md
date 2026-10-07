# Using the current whiteboard

Create a workflow from the library, give it a name, and describe the outcome it should achieve. Add blocks and write instructions in your own words. Connect blocks by their dots or choose a next block in the detail panel; click a connection to explain when that path is taken.

The current surfaces are the workflow library (`/`), creation dialog, and board (`/workflows/:id`) with block, connection, and workflow detail panels. Everyone using the protected demo workspace has the same capabilities.

Save persists detail changes. Moving a block saves its position. If another tab has edited the same item, compare the saved version with your preserved draft before retrying. Removing a block also removes its paths and clears its merge pairing.

Parallel and conditional settings describe intended behavior. Review, freeze, agent generation, and execution are still upcoming; the current board does not perform work or send messages.

See the [functional specification](../specs/whiteboard-authoring.md) for validation, conflict behavior, and current limitations, and the [whiteboard PRD](whiteboard-prd.md) for the full intended feature.
