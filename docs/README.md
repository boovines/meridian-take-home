# Documentation

Start here when working on Meridian Studio. Use the [application setup and module map](../app/README.md) to run it, [contribution rules](../CONTRIBUTING.md) before changing it, and [verification plan](verification.md) to choose checks.

## Find the right document

| Task | Read |
| --- | --- |
| Understand customer scope and decisions | [Whiteboard PRD](product/whiteboard.md), [Self-Healing Agent PRD](product/self-healing-agent.md) |
| Understand system boundaries and diagrams | [Architecture](architecture/overview.md) |
| Change persistence or evaluate a schema choice | [Data-model audit](architecture/data-model.md), then [executable migrations](../app/migrations) |
| Change an implemented feature | Its contract in the feature list below, then the relevant source/tests |
| Run or demonstrate the application | [Demo walkthrough](guides/demo.md), [technical handoff](guides/handoff.md) |
| Check the take-home minimum deliverables | [Requirement-to-evidence audit](guides/take-home-minimum.md) |
| Check what has actually been verified | [Implementation evidence](implementation-status.md), [verification commands](verification.md) |
| Recover original interview rationale | [Archived interview decisions](archive/interviews/README.md) |

## Approved feature specifications

- [Guided workflow scaffolding](product/guided-workflow-scaffolding-spec.md): approved requirements for notes, scoping interviews and initial graph generation.

## Implemented features

Each feature document combines usage, rules, failure handling and verification references in one place.

- [Whiteboard authoring](features/whiteboard-authoring.md)
- [Guided workflow scaffolding](features/guided-workflow-scaffolding.md)
- [AI review and frozen handoff](features/review-handoff.md)
- [Implementation plans and code generation](features/engineer-generation.md)
- [Gmail input capture](features/gmail-inputs.md)
- [Selected-email grouped execution](features/grouped-execution.md)
- [Workflow runtime and human responses](features/workflow-runtime.md)
- [Trusted evaluations](features/trusted-evaluations.md)
- [Bounded repair](features/bounded-repair.md)

## Authority and maintenance

PRDs record intended product behavior. Feature contracts describe implemented behavior; confirm it against source and tests when making changes. SQL migrations define the executable database schema. The architecture/data-model audit explains why those boundaries exist. The evidence log records dated checks, not a blanket guarantee about later changes. Flag disagreements explicitly rather than treating an older proposal as current implementation. Current feature contracts describe this checkout; dated evidence and pending PRs do not automatically describe the current running deployment. Setup commands have one canonical home in the app README; walkthroughs link there.

Archived interviews preserve decisions and alternatives, including tables that were later omitted. They are background, not competing specifications. Keep future scope in the [root README](../README.md#future-work-outside-demo-scope).

Update the existing document for a topic before creating another. Link every new document from this index or a linked section index. Run `npm run docs:check` from `app/` to catch missing local links and documents unreachable from this index.

## Finding older paths

| Former location | Current location |
| --- | --- |
| `specs/<feature>.md` and `docs/<feature>.md` | One combined `docs/features/<feature>.md` |
| `docs/whiteboard-prd.md`, `docs/self-healing-agent-prd.md` | `docs/product/whiteboard.md`, `docs/product/self-healing-agent.md` |
| `docs/architecture.md`, `docs/data-model-decisions.md` | `docs/architecture/overview.md`, `docs/architecture/data-model.md` |
| `docs/demo.md`, `docs/handoff.md` | `docs/guides/demo.md`, `docs/guides/handoff.md` |
| `.plans/meridian-*.md` | Original filenames under `docs/archive/interviews/` |
