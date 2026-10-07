// Business requirements for the example process, never evaluator answers or runtime overrides.
// Kept outside the generic editor/runtime so another workflow can use the same platform.
export const receivingExample = {
  name: "Import receiving · shipment verification",
  desired_outcome:
    "Verify a selected shipment's commercial invoices and batch certificates, then preview a report with invoice, failed-good, and batch totals plus actionable missing-field and missing-certificate details. Do not send email or change Gmail.",
  steps: [
    {
      key: "packet",
      type: "trigger",
      title: "Select shipment packet",
      x: 330,
      y: 0,
      initial:
        "Use the selected existing shipment email and related certificate replies. Capture all attachments and start one shipment verification.",
      instructions:
        "Accept an immutable captured packet with shipment_reference, messages, and documents. One packet represents one shipment; the operator selects all related existing invoice and certificate emails. Preserve all source metadata. Extraction must confirm the container or MAWB identifier from email body text against the selected reference; conflicting shipment identities require attention. Gmail is read-only. Both extraction branches receive the same packet. Unsupported ancillary attachments are retained but not claimed as verified; invoice and CoA evidence must come from readable PDF documents. The demo does not inspect Excel ASN content or score invoice/ASN mismatches.",
      method: "code",
    },
    {
      key: "invoices",
      type: "information",
      title: "Read commercial invoices",
      x: 90,
      y: 210,
      initial:
        "Read the commercial invoices and extract goods, required identifiers, and batch numbers.",
      instructions:
        "Identify commercial invoice pages across the captured PDFs, including multiple invoices in a combined document and continuation pages. A packing list, bill of lading, certificate, or email summary is not an invoice. Extract invoice number; each distinct goods line with description, line identity, HTS, ANDA, FDA product code, registration number (REG), and NDC as written; and all batch numbers appearing on the invoice. Record source artifact IDs and page numbers. Keep absent values null and never borrow an identifier from another good or another document. Shared invoice text may apply to a good only when explicitly stated to cover it. Preserve batch suffixes. Preserve distinct goods lines even with identical drug descriptions; repeated copies of the same invoice are deduplicated by invoice number, with continuation lines combined. Conflicting copies or unreadable invoice evidence require attention rather than guessed values. Confirm shipment identity from message body text. Return structured evidence, not final success counts. No invoice found is an execution error. PDF filename hints can exclude clearly named packing lists and transport-only documents, but ambiguous PDFs must be inspected for invoice content.",
      method: "agent",
    },
    {
      key: "certificates",
      type: "information",
      title: "Read batch certificates",
      x: 590,
      y: 210,
      initial:
        "Find each Certificate of Analysis and extract the batch it certifies.",
      instructions:
        "Find actual Certificate of Analysis pages across the captured PDF documents, including certificates embedded in combined document packets and separate email replies. Read document contents, not just filenames. Extract certified batch numbers with artifact ID and page evidence. Certificate of Conformance, USDA declarations, packing lists, and invoice batch listings alone are not CoA evidence. A file can contain several document types or several batches. Preserve meaningful suffixes such as A and distinguish a product code from a batch number. Missing CoAs yield an empty or partial certificate list, not an extraction error; unreadable potentially relevant certificate evidence requires attention. Return structured certificate evidence. Clearly named invoice, packing-list, and transport-only PDFs can be excluded; inspect ambiguous PDFs. Do not infer certificates from email claims or invent missing identifiers.",
      method: "agent",
    },
    {
      key: "validate",
      type: "check",
      title: "Validate goods and batches",
      x: 330,
      y: 440,
      initial:
        "Wait for both extraction branches. Check that each good has HTS, ANDA, FDA, REG and NDC. Check each invoice batch has a matching CoA. Calculate the shipment totals.",
      instructions:
        "Wait for both extraction branches and validate their structured evidence deterministically. Normalize identifier whitespace and case for comparison without removing meaningful batch suffixes. Deduplicate invoices by invoice number within the shipment and batches by batch number across those invoices. Do not deduplicate distinct goods lines by drug description. A good missing ANY of HTS, ANDA, FDA, REG, NDC fails once; retain every missing field in its error detail. Any failed good makes its invoice fail once. Invoice success depends only on these goods-field checks. Batch success depends separately on an actual CoA for the invoice batch. An invoice packaging batch and a CoA manufacturing batch can match despite a terminal packaging suffix when the source documents corroborate the same product, strength and manufacturer and support that relationship. A shared prefix alone is insufficient. Preserve both original identifiers and the evidence supporting the relationship; do not rewrite source identifiers or merge distinct invoice batches. A missing CoA or an unsupported relationship fails that batch without changing invoice/failed-good counts. Do not count extra certificates as processed invoice batches. Reject conflicting extraction data or malformed evidence as execution errors, never as a business pass. Return shipment_reference, totals with exactly invoices_processed, invoices_succeeded, invoices_failed, goods_failed, batches_processed, batches_succeeded, batches_failed, and error details naming the invoice, good description, missing fields or missing batch. Preserve source evidence for inspection. Processed equals succeeded plus failed for invoices and batches. Do not score ASN mismatches.",
      method: "code",
    },
    {
      key: "report",
      type: "outcome",
      title: "Preview receiving report",
      x: 330,
      y: 650,
      initial:
        "Preview the shipment's invoice, failed-good and batch counts, with an error summary. Do not send email.",
      instructions:
        "Return the validation output, including shipment_reference, totals, error details and source evidence, plus report: {subject, body}. Subject names the shipment; body explains all seven totals and lists each failed good once with its missing fields and each failed batch with the missing CoA. Successful validation can still report business failures; those counts must not be silently changed. If no business issues exist, say the shipment checks passed. No recipient is invented and nothing is sent. This workflow ends with an inspectable preview; requesting replacement documents is outside this demo and requires a new captured packet/run. Unreadable input or execution failure is surfaced as Needs attention by the platform, not a successful report.",
      method: "code",
    },
  ],
} as const;
