# Batch relationship policy fixtures

These are fictional documents for the example import-receiving workflow. They contain no customer data or generated implementation code. The PDFs are real inputs to the same document-reading path as supplied shipments; they are not mocked model responses.

Every invoice contains one good, all five required identifiers, and one packaging batch (`DEMO7701A`). The corresponding CoA certifies manufacturing batch `DEMO7701`.

| Case | Independent reason | Expected batch result |
| --- | --- | --- |
| Supported | Product, strength and manufacturer agree; the CoA explicitly links the packaging and manufacturing batches. | 1 succeeded, 0 failed |
| Different product | The CoA certifies Betacin; the invoice names Alphacin. A shared strength/prefix is insufficient. | 0 succeeded, 1 failed |
| Different strength | The invoice is 10 mg; the CoA certifies 20 mg. Shared product words/prefix are insufficient. | 0 succeeded, 1 failed |
| Different manufacturer | The invoice names Example Labs; the CoA names Other Works. No relationship corroborates the different manufacturer. | 0 succeeded, 1 failed |

Invoice totals are always 1 processed, 1 succeeded, 0 failed, 0 failed goods. Batch failures do not change goods-field validation. `manifest.json` stores these human-readable expectations separately from the input PDFs. They must be verified and locked before repair; the coding agent cannot edit them.

These cases supplement the eleven supplied real shipments. Passing them does not establish accuracy on those shipments, and passing shipment totals alone does not establish this policy. They are optional live evaluation inputs, not paid tests in required CI. Regenerate the deterministic PDFs with `python3 scripts/demo/build-policy-fixtures.py` from `app/` (requires ReportLab). The original generated artifacts are committed so normal development needs no Python dependency.
