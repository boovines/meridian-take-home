# Development workflow

Use a feature branch and pull request for changes to `main`. Prefer `codex/<short-description>` for agent work. A PR can cover a substantial, coherent milestone spanning UI, API, and database; do not split tightly connected work just to reduce line count.

Describe what changed, how it was verified, and any known limitations. Review business rules, schema changes, state transitions, and failure handling before merging. No external approval is required for this solo project. Resolve review conversations, wait for required checks, then squash merge with a descriptive PR title. Merged remote branches are deleted automatically.

## Verification

The repository currently has no application runtime. CI checks the scaffold and whitespace introduced by the PR; it does not claim to test application behavior. Run `git diff --check` locally before committing.

When initializing the app, add reproducible install commands and a lockfile, then make lint, typecheck, and production build real CI checks in the same PR. Document exact local commands in `app/README.md`. Add focused behavioral tests with the features they exercise; see [the verification plan](docs/verification.md).

Keep CI independent of live Gmail and LLM credentials. Use saved, sanitized fixtures for required checks and verify live integrations separately before the demo. Do not add placeholder tests, coverage quotas, or exhaustive component snapshots.

When adding or renaming CI jobs, run them successfully before updating required checks in GitHub. Remove obsolete required check names at the same time so merges cannot wait forever for a check that no longer exists.
