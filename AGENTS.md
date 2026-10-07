# Repository conventions

- Start with `docs/README.md` to find product, implementation and schema context. Read `CONTRIBUTING.md` before implementation. Work on a feature branch and open a PR; do not push directly to `main`.
- Leave feature PRs open. Stack dependent work on its predecessor branch and test the combined implementation locally. Passing CI is not permission to merge; wait for Justin's explicit approval.
- Run checks appropriate to the change and report actual results. Do not claim scaffold CI verifies app behavior.
- When initializing the app, add real lint, typecheck, and build commands to CI. Add focused business-rule, persistence, and browser tests as their features land, following `docs/verification.md`.
- Keep expected evaluation answers independently reviewed and fixed during repair. Do not change expected answers just to make failing implementation pass.
- Prioritize execution trace/audit evidence when improving repair: localize where behavior diverges before adding more examples. Improve the reusable harness, not shipment-specific platform logic. Cases already exposed to repair are regression tests, not held-out validation; any claimed holdout must use fresh independently verified cases.
- Use fixtures for required CI; keep live Gmail/LLM verification separate. Never commit credentials or unsanitized customer data.

## File placement

- Keep HTTP handlers in `app/src/app/api` thin. Put transactional feature logic in `app/src/server/<feature>` and pure contracts/rules in `app/src/domain`. UI components belong in their feature folder under `app/src/components`.
- Share workflow row locking and graph reads through `server/workflows/store.ts`; keep provider clients in `server/integrations`. Temporal workflow code stays in `src/worker` and must not import database or network implementations at runtime.
- Put migrations in `app/migrations`, behavioral tests in `app/tests`, browser journeys in `app/tests/browser`, and sanitized fixtures in `app/tests/fixtures`. Keep generated projects and scratch/runtime state outside source under ignored `.runtime/`.
- Use ignored `work/` for temporary verification renders and handoff-building tools. Reusable operator commands belong in `app/scripts`; promote them deliberately instead of importing scratch files into the application.
- Split a growing module by a concrete feature or responsibility; avoid catch-all utilities and folders with no implemented purpose. Update the app README map when a new boundary is introduced.

## Maintainability and documentation

- Put cross-feature errors and scalar validation in named shared domain modules, not another feature's contract. Domain code stays independent of UI, server and worker implementations; browser code must not import server/worker implementations. Keep deterministic Temporal workflows free of runtime I/O imports.
- Split modules around a concrete responsibility (for example, fetching workspace state versus rendering controls), not an arbitrary line count. Keep feature-specific code together; avoid generic utility buckets, speculative abstractions, and duplicate data ownership.
- Preserve existing behavior and visual design during structural refactors. Use focused behavior tests and existing browser journeys to check the affected flows; run lint, typecheck and relevant build/worker checks.
- Keep one canonical document per topic under `docs/`. Update the feature contract when behavior changes and the app README when module boundaries change. Link new documents from `docs/README.md` or a reachable section index; run `npm run docs:check`.
- Treat `docs/archive/interviews/` as historical context. SQL migrations are the executable schema; do not implement superseded tables just because an archived proposal lists them. Do not recreate root `specs/` or `.plans/` directories.
- PR descriptions explain the concrete problem, resulting behavior and actual validation. Omit conversational history and standing workflow instructions.

## Skills

- For frontend development, automatically load and use `$jhouui` (`~/.codex/skills/jhouui/SKILL.md`) without requiring explicit invocation. Use its live variants when developing visual designs; preserve an explicitly chosen design and avoid unnecessary variants for behavior-only fixes. Per Justin's project instruction, generate and inspect three variants, choose the strongest using your own judgment, apply it, remove the picker scaffolding, and explain the choice. Do not wait for Justin to select a variant.
- Use `$jhou-grab` (`~/.codex/skills/jhou-grab/SKILL.md`) when the user asks to save a UI design or find a saved pattern. Search the library when prior designs are relevant to frontend work; save a design only when requested, including after a `jhouui` selection. Adapt references to this project's tokens and components.
- Use `$animation-judgement` (`~/.codex/skills/animation-judgement/SKILL.md`) when adding, changing, or reviewing transitions, animations, hover/press feedback, or popover motion. Check reduced-motion behavior and rapid interactions; treat timing values as guidance. Skip it for changes unrelated to motion.
- Use `$feature-spec` (`~/.codex/skills/feature-spec/SKILL.md`) when documenting an implemented feature or checking its actual behavior against a PRD. Trace user flows, business rules, permissions, and failure states from the code; flag discrepancies. Keep documentation proportional to the request. Use this for existing behavior, not pre-implementation requirements, and do not generate specs for every code change. Use this repository's combined `docs/features/<feature>.md` convention instead of separate `specs/` and `docs/` outputs.
