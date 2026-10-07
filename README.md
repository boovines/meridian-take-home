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

The initial feature is a visual whiteboard for process owners to map a workflow, resolve AI review comments, test a draft, and freeze a spec for implementation. The [whiteboard PRD](https://docs.google.com/document/d/1lm6Txi2R_2dzBoeF3z7NN9Km9OctxaamYB-EW4WXdoE/edit?tab=t.t8uhdbuizy7d) is the current scope reference.

## Development status

See [CONTRIBUTING.md](CONTRIBUTING.md) for the lightweight PR workflow and [docs/verification.md](docs/verification.md) for the staged CI plan. Large, coherent milestone PRs are welcome; merge through a PR after required checks pass.

No application dependencies or feature implementation have been chosen yet. After the decomposition interview, update `app/README.md` with setup and run commands, `docs/architecture.md` with the agreed design, and CI with real build and test checks. Keep secrets in local environment files, never in Git.
