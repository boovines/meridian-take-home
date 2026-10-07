# Repository conventions

- Read `CONTRIBUTING.md` before implementation. Work on a feature branch and open a PR; do not push directly to `main`.
- Coherent milestone-sized PRs are appropriate for this three-day project. Avoid unnecessary fragmentation or unrelated changes.
- Run checks appropriate to the change and report actual results. Do not claim scaffold CI verifies app behavior.
- When initializing the app, add real lint, typecheck, and build commands to CI. Add focused business-rule, persistence, and browser tests as their features land, following `docs/verification.md`.
- Keep expected evaluation answers independently reviewed and fixed during repair. Do not change expected answers just to make failing implementation pass.
- Use fixtures for required CI; keep live Gmail/LLM verification separate. Never commit credentials or unsanitized customer data.
