import { PDFDocument } from "pdf-lib";
import { DomainError } from "../../domain/errors";
import type { EvidenceDocument } from "../../domain/extraction";
import type { ReasoningDocument } from "./documents";

export async function evidenceDocuments(
  documents: ReasoningDocument[],
): Promise<EvidenceDocument[]> {
  const result: EvidenceDocument[] = [];
  for (const doc of documents) {
    let page_count = 1;
    if (doc.media_type === "application/pdf") {
      try {
        page_count = (
          await PDFDocument.load(doc.bytes, { updateMetadata: false })
        ).getPageCount();
      } catch {
        throw new DomainError(
          422,
          "INVALID_DOCUMENT",
          "Could not determine the captured PDF's pages for evidence verification.",
        );
      }
    }
    result.push({ artifact_id: doc.artifact_id, page_count });
  }
  return result;
}
