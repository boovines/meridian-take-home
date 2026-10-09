# Demo readiness audit — October 9, 2026

This is an active failure register, not a readiness certification. Reported symptoms are kept separate from reproduced failures and confirmed causes. No fixes had been made when this register was opened.

## Baselines and scope

- Local isolated checkout: `4a48f60`, branch `codex/demo-readiness`, stacked on `codex/equal-review-panes` (PR 63).
- Existing uncommitted freeze/method-suggestion changes remain in the original checkout and are not part of this initial baseline.
- Latest production deployment: `dpl_3auMhztd84b3JzwCNwnPqR5jFPzE`, alias <https://meridian-take-home.vercel.app>, created October 9 at 17:26 EDT.
- An existing worker runs from a separate checkout at `79ab206`; compatibility is under investigation. Do not replace a worker while its operations are active.
- Required coverage: authoring/save/reopen, review/reply/freeze, method approval/generation/source, input capture, execution/human response/report/audit, evaluations and bounded repair; errors, reloads and interrupted requests.
- Fixture tests and live provider checks are separate evidence. Existing exposed cases are regression coverage, never held-out validation.

## Failure register

| ID | Symptom | Evidence/status | Cause | Repair/verification |
| --- | --- | --- | --- | --- |
| DEMO-001 | Order entry workflow did not complete | User-reported; not yet reproduced | Unknown; insufficient description is only a hypothesis | Pending reproduction |
| DEMO-002 | Wi-Fi interruption disrupted walkthrough | User-reported; recovery behavior to test | Network interruption reported; application recovery unknown | Pending interrupted-request tests |
| DEMO-003 | Review flow unreliable live | User-reported; not yet reproduced | Unknown; API/payment explanation unconfirmed | Pending local and deployed review |
| DEMO-004 | Agent generation unreliable live | User-reported; not yet reproduced | Unknown; API/payment explanation unconfirmed | Pending provider and generation checks |
| DEMO-005 | Execution/audit view did not display | User-reported; not yet reproduced | Unknown; migration explanation unconfirmed | Pending historical and fresh audit inspection |
| DEMO-006 | Business logic loses context while becoming executable contracts | User-reported broader failure mode | Requires trace localization against independently fixed expectations | Pending controlled generation/execution evidence |

## Verification log

Initial baseline checks are in progress. Record exact commands and observed outcomes here; a deployment status of Ready does not establish application readiness.
