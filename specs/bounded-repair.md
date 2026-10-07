# Bounded repair — implemented behavior

Entry point: engineer workspace → Evaluation → failed evaluation → Repair and rerun. History remains within the Evaluation tab. Read-only project/diff inspection uses the existing Agent view; generated versions remain downloadable.

## Contract and ownership

`POST /api/workflows/:id/repairs` accepts a UUID request key and baseline evaluation ID. Reusing the same key and baseline returns the existing session; changing that request conflicts. Only a completed/blocked evaluation with repairable implementation evidence, the latest locked suite and an approved plan can start. The workflow's exclusive operation slot prevents competing generation, execution, evaluation or repair. `GET /repairs` lists the latest 20 sessions and the selected session's bounded attempts; `GET /repairs/:sessionId` retrieves older selected history. Cancellation uses the existing job endpoint.

`domain/repair.ts` validates requests and baseline eligibility. `domain/grading.ts` compares exact case/suite/assertion coverage and preserves previous passes. `server/repairs/service.ts` enforces transactions, ancestry, invocation ownership, acceptance and terminal history. `generation-service.ts` handles complete artifact checkpoints and project assembly. The OpenAI adapter receives frozen requirements, approved methods, baseline source, trusted cases/results, case-associated step traces and prior attempt diagnoses plus their actual assertion failures and execution errors. Its context is limited to 200 KB; larger evidence requires engineer attention.

`worker/repair-workflow.ts` runs up to three generation/evaluation/decision cycles within the recorded two-hour job deadline. Each candidate evaluation reuses the ordinary suite and workflow execution paths under the existing repair job. Evaluation completion does not finish the repair job. The host reassembles fixed project scaffolding and never lets candidate code edit trusted tests or choose its own acceptance result.

## Observable outcomes

- Passed: a candidate preserves every previous pass and the complete locked suite passes.
- Rejected attempt: a regression, execution error, missing coverage or inconclusive result leaves the baseline unchanged; the candidate is still inspectable.
- Accepted attempt with remaining failures: the candidate becomes the baseline and repair continues within the limit.
- Needs attention: the three-attempt/time limit, a scope/method decision, or newly discovered non-implementation blocker stops autonomous work.
- Failed/cancelled: the service retains attempted source and finished results, closes unfinished projections and fences late writes. The engineer can inspect and explicitly start another session when eligible.

A suite correction creates a new version, requests active repair cancellation, preserves old expectations/results, and requires a fresh baseline evaluation before another session. No automatic method changes, test rewriting, post-freeze process revisions, IDE edit import, outbound delivery or unlimited retry is implemented.

Verification evidence and live command are in `docs/bounded-repair.md`. The current demo has no production load test or unbounded history pagination.
