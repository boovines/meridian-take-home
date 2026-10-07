# Captured Gmail inputs

An engineer searches the configured shipment mailbox, chooses existing emails, and captures their contents before running a workflow. Capture reads email without marking it read, editing it, or sending anything. Related messages can be selected together when invoices and certificates arrive separately.

The capture preserves each email's text and envelope plus every attachment. A finished capture is a fixed input packet: retries and evaluations use its saved bytes even if the mailbox later changes. If any attachment fails to download, no partial packet becomes runnable. Retrying capture creates a separate packet.

The capture API and operator smoke check are implemented; the email selection and run screen is the next feature. Existing captured inputs are available to the evaluation case editor. Workflow steps may ask to interpret supported captured documents; unreadable or unsupported requested files stop that step with an error.

The [functional specification](../specs/gmail-inputs.md) covers limits and failure behavior. Setup and live verification commands are in the app README.
