# Captured Gmail inputs

An engineer searches the configured mailbox and selects existing emails under Agent → Run workflow. Capture reads email without marking it read, editing it, or sending anything. Related messages may be selected together when documents arrive separately. Saved inputs preserve source evidence for subsequent runs and evaluations; existing runs never re-query Gmail.

## Entry points and behavior

The engineer searches using ordinary Gmail search terms. Results show subject, sender, received time, and pagination. Selected emails starts a durable operation that captures sources before grouping and execution. Saved input also offers a foreground capture with a shipment reference. There are no role-specific permissions in this demo; mailbox access must stay within the operator's local or access-protected deployment.

### Durable selected-email capture

The run panel shows captured-email counts, downloaded-attachment counts, and unavailable attachments with their names and reasons. Counts persist across reloads and remain in the operation history. Attachment totals grow as email envelopes are captured. Capture starts no model work; grouping starts only once capture is sealed.

Up to four source requests run concurrently. Each request has a 20-second deadline and at most two attempts. Captured envelopes and attachment bytes are checkpointed per operation. An automatic worker retry reuses completed items instead of fetching them again. Successful downloads are immutable for that operation. A new top-level run creates fresh capture evidence rather than reusing another operation's checkpoints.

If an attachment still cannot be downloaded after its bounded retry, capture preserves a named unavailable-evidence record with the original email/attachment identity and a safe failure reason. That record is not the missing file's contents. It remains attached to the email and available in the corresponding child input; it cannot be interpreted as a real document. The agent must follow the frozen process's missing-evidence rule or stop for attention if no rule is approved. A download failure is never proof that no purchase order or other business evidence exists.

A message-fetch failure prevents sealing because the message's content and attachment inventory are unknown. Authorization failures stop with a Gmail reconnect instruction, rather than converting the entire mailbox to unavailable attachments. Cancellation and size-limit failures also prevent publication. Database ownership checks fence writes from cancelled or finished jobs; completed checkpoints remain retained.

Each capture attempt has a 20-minute deadline, a 22-minute activity ceiling, and at most two activity attempts within 45 minutes. These are capture bounds, not extensions to the selected-email operation's shared active-time budget. Timeouts report the capture failure and retained progress rather than claiming the generated agent failed.

### Strict foreground capture

The standalone Gmail capture endpoint and Saved input capture still download every selected attachment before publishing a packet. A disconnected request or failed download may leave retained artifacts, but cannot publish a partial packet. Retrying creates a separate packet. This foreground request has a four-minute deadline and does not start a workflow automatically.

## Document reading

An approved Agent step may request specific documents from its saved packet. The interpretation service accepts PDF, PNG, JPEG, WebP, plain text, and CSV. Other formats remain captured but cannot be interpreted. Unsupported, invalid, oversized, and explicitly unavailable documents return errors rather than an empty successful extraction.

Unavailable-attachment records retain failure evidence, not attachment bytes. If generated code tries to interpret one, execution reports an input failure; it cannot repair missing bytes by changing code. New generation instructions explain how to preserve warnings and follow approved missing-evidence behavior. Existing generated versions are not rewritten by deploying the capture change.

Steps cannot read another run's uncaptured document, fetch arbitrary URLs, or access local paths. Code steps cannot request model interpretation. Human response requirements are unaffected. Interpretation is not itself a verified business result; locked evaluations compare final outputs against independent expectations.

## Limits and exits

Selections must be nonempty and contain distinct valid message identifiers. Durable selected-email capture supports at most 100 sources, including email envelopes and at most 90 attachments. The foreground path also limits attachments to 90. Both enforce 25 MB per captured file, 50 MB of attachment bytes per packet, 150 KB of text per email, and 512 KB of combined input/metadata. Foreground capture requires a nonblank shipment reference of at most 200 characters. Exceeding a limit leaves no runnable packet.

One interpretation request may read up to 20 distinct captured documents and 20 MB total, with at most 200 KB per text file. It never sends email, modifies Gmail, approves a human task, or alters expected evaluation results.

## Verification

Sanitized persistence tests cover interrupted capture/resume, attachment timeouts and provenance in child inputs, bounded concurrency, authorization failure, cancellation fencing, size limits, and idempotent publication. Browser fixtures check progress, warnings, actionable errors, and reload persistence. The Temporal worker suite checks orchestration separately. These checks do not establish live Gmail availability or document-classification accuracy. Setup and optional live verification commands are in the [app README](../../app/README.md#gmail-capture).

## Saving an explicit Gmail draft

After a completed manual run produces one email preview from one Gmail message, its result offers **Enable Gmail drafts for this workflow**. This setting is off by default and scoped to that workflow. Enabling it does not create anything automatically. **Create Gmail draft** saves the displayed subject and body through the connected Composio Gmail account; it never sends. The recipient starts blank unless the preview explicitly includes one, and remains editable before creation. No sender address is inferred. Preview generation and frozen process requirements are unchanged; this is an explicit action after execution.

Fixture inputs, evaluation runs, unsuccessful runs, grouping/aggregate phases and results without a preview cannot write drafts. The server reads the immutable saved result; clients cannot replace the subject or body. One reservation per workflow, connected account and source message prevents concurrent clicks and later reruns from creating duplicates. Different requested contents for an already-reserved source require checking the existing Gmail draft. A timeout, rejected request or lost response is retained as uncertain and never automatically retried. Check Gmail and the connection before operator reconciliation; the app does not claim exactly-once delivery across provider failures. Changing credentials or granting Gmail scopes remains an operator action.

Migration 020 stores workflow opt-ins and draft receipts with row-level security. `server/gmail-drafts` owns reservation and eligibility; the provider remains in `server/integrations/composio-gmail.ts`. Tests use a fake draft writer and do not modify Gmail.
