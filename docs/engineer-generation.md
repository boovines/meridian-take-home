# Engineer workspace

Open **Engineer workspace** from a frozen whiteboard to turn the customer’s process into an implementation plan and inspectable code.

- **Implementation:** Create a plan, optionally request AI method suggestions, choose Code, Agent, or Human for each step, and approve the choices. Customer-required human steps stay human. Approve the complete plan to enable generation.
- **Agent:** Follow background progress, cancel an operation, select a completed code version, inspect its files, compare with its parent, and download the project ZIP.
- **Evaluation:** The current feature explains that generated code still needs verified tests. Evaluation and repair are separate implementation milestones.
- **Operation history:** Inspect completed, failed, or cancelled generation attempts. Existing code remains available while new work runs.
- **Frozen whiteboard:** Return to the customer’s unchanged process through the header link.

Generation continues when you close or reload the browser. A successful generation means the project was saved and its JavaScript passed syntax validation. It remains **Not yet evaluated** until business behavior is checked against trusted expectations.

Use **Revise plan** to change an approved method. A revision preserves the previous plan and code, copies choices into a new draft, and requires fresh approvals. Only one draft plan and one active expensive operation are allowed per workflow.

The workspace is at `/workflows/:id/engineer`; the source whiteboard is at `/workflows/:id`. The demo has no separate role permissions. There is no code editor, repository synchronization, automatic deployment, or email sending. Downloads invoke individual steps under a host; they do not silently bypass agent requests or human gates.

See the [functional specification](../specs/engineer-generation.md) for lifecycle, concurrency, error handling, and current limits.
