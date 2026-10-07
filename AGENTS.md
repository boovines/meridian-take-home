# Repository conventions

- Read `CONTRIBUTING.md` before implementation. Work on a feature branch and open a PR; do not push directly to `main`.
- Run checks appropriate to the change and report actual results. Do not claim scaffold CI verifies app behavior.
- When initializing the app, add real lint, typecheck, and build commands to CI. Add focused business-rule, persistence, and browser tests as their features land, following `docs/verification.md`.
- Keep expected evaluation answers independently reviewed and fixed during repair. Do not change expected answers just to make failing implementation pass.
- Use fixtures for required CI; keep live Gmail/LLM verification separate. Never commit credentials or unsanitized customer data.

## Skills

- For frontend development, automatically load and use `$jhouui` (`~/.codex/skills/jhouui/SKILL.md`) without requiring explicit invocation. Use its live variants when developing visual designs; preserve an explicitly chosen design and avoid unnecessary variants for behavior-only fixes. Wait for the user’s selection before applying a variant.
- Use `$jhou-grab` (`~/.codex/skills/jhou-grab/SKILL.md`) when the user asks to save a UI design or find a saved pattern. Search the library when prior designs are relevant to frontend work; save a design only when requested, including after a `jhouui` selection. Adapt references to this project's tokens and components.
- Use `$animation-judgement` (`~/.codex/skills/animation-judgement/SKILL.md`) when adding, changing, or reviewing transitions, animations, hover/press feedback, or popover motion. Check reduced-motion behavior and rapid interactions; treat timing values as guidance. Skip it for changes unrelated to motion.
- Use `$feature-spec` (`~/.codex/skills/feature-spec/SKILL.md`) when documenting an implemented feature or checking its actual behavior against a PRD. Trace user flows, business rules, permissions, and failure states from the code; flag discrepancies. Keep documentation proportional to the request. Use this for existing behavior, not pre-implementation requirements, and do not generate specs for every code change.
