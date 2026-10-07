# Development workflow

Use a feature branch and pull request for changes to `main`. Prefer `codex/<short-description>` for agent work.

Describe what changed, how it was verified, and any known limitations. Review business rules, schema changes, state transitions, and failure handling before merging. Resolve review conversations, wait for required checks, then squash merge with a descriptive PR title.

## Verification

Run `git diff --check` and the checks relevant to your changes before committing.

When initializing the app, add reproducible install commands and a lockfile, then make lint, typecheck, and production build real CI checks in the same PR. Document exact local commands in `app/README.md`. Add focused behavioral tests with the features they exercise; see [the verification plan](docs/verification.md).

Keep CI independent of live Gmail and LLM credentials. Use saved, sanitized fixtures for required checks and verify live integrations separately before the demo. Do not add placeholder tests, coverage quotas, or exhaustive component snapshots.

When adding or renaming CI jobs, run them successfully before updating required checks in GitHub. Remove obsolete required check names at the same time so merges cannot wait forever for a check that no longer exists.
