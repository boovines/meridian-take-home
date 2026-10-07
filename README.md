# Meridian Take-Home

A workspace for the Meridian whiteboard feature. This is the pre-implementation scaffold; the product and technical scope can still change after decomposition.

## Repository layout

```text
app/                 React application and feature code
  src/               Application source
  tests/             Behavior-focused tests
  README.md          App setup and run instructions

docs/                Product, architecture, and verification notes
scripts/             Local setup and demo helpers
.github/workflows/   Continuous integration
.runtime/            Local/generated data (ignored)
```

This follows the organization of my ASWE-4156 miniproject: an isolated application directory, a root README, dedicated docs and scripts, and CI at the repository root. The course project's Java service, data, and assignment files are intentionally not copied.

## Product scope

The demo lets process owners map a workflow, clarify it through AI review, and freeze a spec for implementation. Engineers approve implementation methods, inspect generated code, evaluate it against trusted expectations, and initiate bounded repair sessions. Start with the revised [Whiteboard PRD](docs/whiteboard-prd.md) and [Self-Healing Agent PRD](docs/self-healing-agent-prd.md), which consolidate the product and schema decisions. The [original Google Docs PRDs](https://docs.google.com/document/d/1ARjmPNDBDeczJDOFiMdOHB7r4_Z6-9CQCb2Mm7PHjiA/edit?usp=sharing) remain unchanged because the current account has view-only access. The [business-requirements interview checkpoint](.plans/meridian-business-requirements-spec.md) retains the detailed decision record.

The [entity-model checkpoint](.plans/meridian-entity-model-spec.md) recommends the records needed to support those requirements. The [canvas schema proposal](.plans/meridian-canvas-schema-spec.md) defines the first four tables, their fields, constraints, indexes, and mutation rules; it has not been applied as a migration.

The [review schema proposal](.plans/meridian-review-schema-spec.md) adds review runs, typed discussion threads, messages, and anchors, including atomic suggestion application and the freeze gate.

The [engineering schema proposal](.plans/meridian-engineering-schema-spec.md) defines approved plan/code/test versions, evaluation results, background operations, and bounded repair history.

The [runtime schema proposal](.plans/meridian-runtime-schema-spec.md) completes execution history, human responses, parallel joins, input bundles, artifacts, and bounded loops. Start with the [consolidated architecture and diagrams](docs/architecture.md) for the overall design.

## Development status

See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR workflow and staged verification. Work on feature branches, report actual checks, and merge through reviewed milestone PRs.

The [data-model decision audit](docs/data-model-decisions.md) explains all 25 reference tables, field groups, alternatives, integrity rules, and query/index choices. It also records corrections from the audit and distinguishes the application records from executor-dependent coordination storage. Read this alongside the schema specs before translating them into migrations.

The main requirements/schema interview is complete. The design is documented; migrations, runtime services, and application features have not been implemented or tested. Infrastructure choices and numeric runtime limits remain engineering defaults to validate. Update `app/README.md` and CI with actual setup/build/test commands as implementation begins. Keep secrets in local environment files, never in Git.

## Future work (outside demo scope)

- **Revise a workflow after handoff.** For the demo, freezing locks the whiteboard; further edits are out of scope. Later, allow customers to create an editable draft from a frozen version while engineers continue working from that unchanged version. Freezing and handing off the revised draft would create a new version, without silently changing the engineer's existing implementation target.
- **Import IDE edits and connect repositories.** For the demo, engineers can preview generated code and diffs and download the project; evaluation and repair operate on app-managed code versions. Later, support importing external edits or synchronizing a Git repository, with each evaluation tied to the exact code version tested.
- **Continuously monitor Gmail.** Demo runs start from an explicitly selected shipment email or shipment number. Automatic runs on new mail are deferred.
- **Support multiple workflow triggers.** The demo requires exactly one active Trigger block when freezing a workflow. Later, support multiple entry points with explicit trigger selection and input contracts for each entry point.
- **Support overlapping parallel sections.** The demo requires explicitly paired parallel splits and merges. More general overlapping parallel routing is deferred.
- **Deliver report emails.** The demo captures and previews the intended report. Actual email delivery is deferred.
- **Generate maps from existing sources.** SOP upload for an initial canvas is a low-priority stretch; automated process mining from business systems is outside demo scope.
- **Benchmark extraction more broadly.** Start with targeted checks on representative demo PDFs; broad comparisons across OCR systems and document collections are deferred.
- **Change documents during a paused run.** Human responses are text or decisions in the demo. New documents require a new input bundle and run; in-run document uploads and dependency-aware reprocessing are deferred.
- **Resume failed runs from checkpoints.** A user-requested retry starts from the beginning with the same code and inputs, linked to the failed run. General failed-step resume is deferred.
