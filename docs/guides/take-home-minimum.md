# Take-home minimum: requirement-to-evidence audit

The v17 results below are historical measurements under their recorded configuration. Subsequent reviewed changes include preflight policy v2 and removal of experimental provider/reinspection settings. Those passes do not establish a confirmation sequence for the current configuration; no new live measurement was run during this review.

Checked October 8 against the [original assignment](https://app.notion.com/p/Meridian-Take-Home-Project-3adfdc07926d80dc9b59f9ce64e07155), [updated agent notes](https://app.notion.com/p/Updated-Notes-on-Agent-38bfdc07926d809ebd18f5609e737300), and agreed scope cuts. The assignment allows the repair loop to reach all cases or as close as time permits. Our later three-consecutive-pass reliability gate is stricter and was met in the historical v17 measurement on the locked suite.

## Product minimum

| Requirement | Concrete evidence | Status / limit |
| --- | --- | --- |
| React whiteboard with simple primitives, branches and exceptions | Seven named business blocks; saved instructions and labeled edges; return-loop and paired parallel routing checks. The real shipment board has parallel invoice/CoA readers and a paired merge. | Implemented. A process owner still edits graph changes manually. |
| Anchored AI comments and changing statuses | Findings anchor nodes/connections; owner replies and resolutions persist. UI distinguishes Open, Answered, Rejected and Resolved. | Implemented; this is contextual discussion, not an autonomous rewrite of the customer process. |
| Two review rounds and consequential revision | The shipment board has three completed live reviews. A finding exposed that the report mentioned missing CoAs but omitted unsupported batch relationships. The owner accepted the clarification and changed the Outcome instructions before the final review. | Live evidence verified in Chrome and persisted snapshots. Earlier failed reviews remain visible. |
| Immutable spec sufficient for generation | The frozen graph includes the revised report instructions, five steps, five connections, desired outcome and review decisions. The approved plan and generated artifacts reference this same frozen spec. | Implemented and verified. Post-freeze editing is deliberately out of scope. |
| Reusable scaffold and real generated code | Shared entry point, step contract, tool boundary and error handling; generated modules contain the workflow's extraction and business rules. Agent steps read PDFs; Code steps validate and report. Source and diffs are inspectable/downloadable. | Live generation verified; no invoice matching algorithm or expected answers in the shared harness. |
| Expected-versus-actual evals and self-repair | Locked suite v5 contains 24 cases / 207 assertions, preserving the original 20 / 161. Repair diagnosed an extra character in CoA extraction, inspected source pages, and changed only the reader's instructions to produce v17. | An earlier v17 sequence stopped on infrastructure error. After generic recovery changes, three fresh evaluations each passed 24/24 cases and 207/207 assertions; the earlier repair history and v12 baseline remain unchanged. |
| Real inbound receiving example via supplied Gmail | Eleven immutable Gmail shipment bundles were captured through Composio. The final v17 manual run on the saved passing-control shipment shows three successful invoices and four batches: three successful, one failed. | Real documents and report verified. Manual selection and preview-only delivery are agreed demo scope. |
| Required stack | React UI, Supabase records, Temporal orchestration, Composio Gmail, Vercel Sandbox for isolated generated code. | Live integrations exercised; fixture CI is separately labeled. |
| Reuse beyond receiving | A small returns workflow completed two consequential review rounds, freeze, generation, and three 6/6 evaluations with recorded configuration. | Evidence of reuse; not broad generalization or a second independent self-repair benchmark. |

The additional v17 measurement under bounded token-count retries completed 23/24 cases with one Temporal heartbeat timeout and no assertion failures in its first run. It cannot count toward confirmation, and no second round was started. Neither infrastructure error is a correct business outcome. The original results and tests are preserved.

A separate sequence under the subsequently changed, recorded heartbeat policy completed three consecutive 24/24-case, 207/207-assertion passes. Earlier passes were excluded. Audit evidence verifies identical code, suite, configuration and request payloads, plus 102 distinct provider response IDs. All original 20 cases and 161 assertions remain unchanged. Independent repeatability measurements do not alter the earlier repair session's status or retained baseline.

## Exact local demonstration

Start from the reviewed main branch using [app setup](../../app/README.md). Run the web app on port 3100 and keep the Temporal worker running. No hosted URL is required for this handoff.

1. Open `/workflows/1edea7a4-b1b7-41a8-8c7d-a90ff204c4ed`. Show the five-block process and the two parallel readers.
2. Open **Review & comments → Show resolved findings and review history**. Expand the report finding. Show the owner answer, three completed reviews, and the changed Outcome instructions. The persisted earlier snapshots demonstrate the before/after wording.
3. Open the engineer workspace. **Implementation** shows approved Agent readers and Code validation/reporting. **Agent** shows actual source, version history and download.
4. **Evaluation → Repair history**: select the v17 attempt. Explain the extra-character extraction diagnosis and limited patch. Show its earlier inconclusive confirmation and preserved v12 baseline, then the three latest independent full passes in Results & history. Do not imply the agent changed the fixed tests or that the old repair session was rewritten.
5. **Agent → Run workflow**: select the v17 manual run for the saved passing-control shipment from October 8 at 12:54 PM Eastern (`af569501-47b1-4756-b864-0863fdb46c59`). Show seven totals, per-item issues and the Not sent report. Reuse the saved run during a short demo rather than paying for another extraction.
6. Briefly show `/workflows/54c0ff8f-3b20-432e-af9b-fe41e4a812f7/engineer` for the smaller returns workflow. Its successful text-input evaluations do not erase the shipment reliability limit.

## Submission package and remaining limits

The repository contains setup, current system diagrams, schema rationale, product contracts and this audit. The technical PDF covers all five requested topics: run instructions; primitive choices; comments/spec data model; the code-versus-graph tradeoff; and what to change with more time. The short video is explicitly an edited walkthrough of actual captured UI states, with expensive waits omitted, rather than an uninterrupted live recording.

The minimum product loop is demonstrated. V17 met the locked-suite repeatability threshold; do not describe the service as production-ready or the result as a guarantee for unseen documents. Remaining limits include broader document/model variability, external-service interruptions, and an incorrect page citation outside the locked assertions. Historical provider comparisons remain incomplete; provider switching and automatic reinspection are outside the supported OpenAI implementation.

Validation recorded with the original handoff was historical fixture evidence. Consult the merged PR checks for the current revision; fixture, database and browser checks establish only the tested application behavior, not live LLM accuracy. The obsolete provider PR was closed without merging.
