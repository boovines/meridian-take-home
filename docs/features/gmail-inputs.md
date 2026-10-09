# Captured Gmail inputs

An engineer searches the configured shipment mailbox, chooses existing emails, and captures their contents before running a workflow. Capture reads email without marking it read, editing it, or sending anything. Related messages can be selected together when invoices and certificates arrive separately.

The capture preserves each email's text and envelope plus every attachment. A finished capture is a fixed input packet: retries and evaluations use its saved bytes even if the mailbox later changes. If any attachment fails to download, no partial packet becomes runnable. Retrying capture creates a separate packet.

Open Agent → Run workflow → Capture from Gmail to search and select emails. Existing captured inputs are also available to the evaluation case editor. Workflow steps may ask to interpret supported captured documents; unreadable or unsupported requested files stop that step with an error.

Setup and live verification commands are in the app README.

## Implementation contract

### Entry points and behavior

The engineer searches existing messages for a workflow, with ordinary Gmail search terms or a shipment reference. Results show subject, sender, received time, and pagination. Select all results loads every results page, deduplicates message IDs, and retains loaded selections if a later page fails. The engineer selects emails and clicks Prepare shipment packets. A model reads only selected email bodies and the workflow instructions to suggest separate packets with references, exact supporting body quotes, and message assignments. The operator inspects the suggestions before capture. Every selected email must appear exactly once in a proposed packet or in an explicit unresolved list; unknown IDs, duplicate assignments, omitted emails, fabricated quotes and duplicate references are rejected. Uncertain emails are not silently captured. Manual single-packet capture remains available as a fallback. No mailbox watcher starts runs automatically.

Search and capture are available under Agent → Run workflow → Capture from Gmail, through the workflow API, and through an operator command. The input selector in evaluation authoring lists successful captures. There are no role-specific permissions in this demo; its mailbox access must stay within the operator's local or access-protected deployment.

Capture preserves the message text, envelope, and attachment identities, then downloads every attachment. It completes only after every selected message and attachment is available. A disconnected request or provider error can leave retained evidence, but cannot publish a partially captured packet. A retry creates a new capture. Existing workflow runs never re-query Gmail.

### Document reading

An approved Agent step may request specific documents from that run's saved packet. It receives the interpretation as JSON. The interpretation service can read PDF, PNG, JPEG, WebP, plain text, and CSV. Other formats remain captured but cannot be interpreted by this reader. The service reports unsupported, invalid, or oversized documents as errors; it never substitutes an empty successful extraction.

The step cannot read a different run's uncaptured document, fetch an arbitrary URL, or access local paths. Code steps cannot request model interpretation. Human response requirements are unaffected. Interpretation is not itself a verified business result; locked evaluations still compare the workflow's final output against independent expectations.

Selecting an unsupported attachment is an implementation error that repair may address by correcting document selection. Repair cannot add reader capabilities, discard required evidence, or change the captured input. Invalid document bytes remain an input error requiring attention.

### Limits and exits

A capture accepts one or more distinct email selections without an email-count cap and a nonblank shipment reference of at most 200 characters. It supports up to 90 attachments, 25 MB per file, 50 MB of attachment bytes per packet, 150 KB of text per email, and 512 KB of combined message/metadata input. Capture has a four-minute deadline. Exceeding a limit leaves no runnable partial packet.

One interpretation request may read up to 20 distinct captured documents and 20 MB total, with at most 200 KB per text file. It does not send email, modify Gmail, approve a human task, or alter expected test results. Neither capture nor interpretation automatically starts a workflow run.

### Automatic packet preparation

Preparation reads message text and attachment metadata, not attachment contents, and does not start a workflow. It uses `OPENAI_EMAIL_GROUPING_MODEL` (default `gpt-5.4-mini`, or the priced `gpt-5.4` when the existing spending guard is enabled) with bounded output and no automatic model retries. Input is bounded to 512 KB combined and 150 KB of text per email. Semantic associations remain suggestions, not verified shipment identity; execution still validates the captured evidence.

Capture saves each suggested packet separately with its inferred reference through the existing immutable capture service. A later packet failure leaves completed captures visible and a retry in the current page skips those successes. The captured-input selector lists the packets for one-at-a-time execution with the existing implementation. This does not introduce a combined multi-shipment run, change frozen requirements, or alter trusted evaluation answers. Reloading clears the preparation UI; previously saved packets remain available in captured inputs.
