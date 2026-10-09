import { PDFDocument } from "pdf-lib";
import { DomainError } from "../../domain/errors";
import type { Database } from "../database";
import type { ArtifactService } from "../artifacts/service";
import type { ReasoningDocument } from "../runtime/documents";

export type ReadRepairDocument = (id: string, pages?: number[]) => Promise<ReasoningDocument>;

// Reserve before returning evidence; a crash may consume allowance but cannot
// reset it. The attempt row serializes reservations across worker processes.
export function repairDocumentBudget(db: Database, attemptId: string, token: string) {
  return async (calls: number, bytes: number) => db.transaction(async (tx) => {
    const row = (await tx.query(
      "SELECT attempt_token,status,document_read_count,document_byte_count FROM repair_attempts WHERE id=$1 FOR UPDATE",
      [attemptId],
    )).rows[0];
    if (!row || row.attempt_token !== token || row.status !== "running")
      throw new DomainError(409, "STALE_REPAIR_RESULT", "This repair invocation no longer owns the attempt.");
    if (Number(row.document_read_count) + calls > 3)
      throw new DomainError(422, "REPAIR_DOCUMENT_LIMIT", "Inspect at most three source documents per repair attempt.");
    if (Number(row.document_byte_count) + bytes > 20 * 1024 * 1024)
      throw new DomainError(422, "DOCUMENT_CONTEXT_TOO_LARGE", "Repair evidence is limited to 20 MB total and 200 KB per text document.");
    await tx.query(
      "UPDATE repair_attempts SET document_read_count=document_read_count+$2,document_byte_count=document_byte_count+$3 WHERE id=$1",
      [attemptId, calls, bytes],
    );
  });
}

// Attempt-scoped evidence access. The caller builds the allowlist from locked
// workflow cases, never from model-supplied paths, URLs, or workflow identifiers.
export class RepairDocumentReader {
  private calls = 0;
  private bytes = 0;
  readonly inspected: { artifact_id: string; content_hash: string | null; source_page_numbers?: number[] }[] = [];
  constructor(
    private workflowId: string,
    private allowed: ReadonlySet<string>,
    private artifacts: Pick<ArtifactService, "read">,
    private signal: AbortSignal,
    private reserve?: (calls: number, bytes: number) => Promise<void>,
  ) {}

  read: ReadRepairDocument = async (id, pages) => {
    this.signal.throwIfAborted();
    if (++this.calls > 3)
      throw new DomainError(422, "REPAIR_DOCUMENT_LIMIT", "Inspect at most three source documents per repair attempt.");
    await this.reserve?.(1, 0);
    if (!this.allowed.has(id))
      throw new DomainError(422, "DOCUMENT_ACCESS_DENIED", "Choose a source document from this locked suite's input inventory.");
    const { artifact, bytes } = await this.artifacts.read(this.workflowId, id);
    this.signal.throwIfAborted();
    if (artifact.kind !== "source_document" || !["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain", "text/csv"].includes(artifact.media_type))
      throw new DomainError(422, "UNSUPPORTED_DOCUMENT", "Repair can inspect captured PDF, image, or text evidence only.");
    if (artifact.media_type === "application/pdf" && !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
      throw new DomainError(422, "INVALID_DOCUMENT", "The captured evidence is not a readable PDF.");
    if (this.bytes + bytes.length > 20 * 1024 * 1024 || (artifact.media_type.startsWith("text/") && bytes.length > 200_000))
      throw new DomainError(422, "DOCUMENT_CONTEXT_TOO_LARGE", "Repair evidence is limited to 20 MB total and 200 KB per text document.");
    this.bytes += bytes.length;
    await this.reserve?.(0, bytes.length);
    this.signal.throwIfAborted();
    let selected = bytes;
    if (pages?.length) {
      if (artifact.media_type !== "application/pdf" || pages.length > 3 || new Set(pages).size !== pages.length || pages.some(p => !Number.isInteger(p) || p < 1))
        throw new DomainError(422, "INVALID_SOURCE_PAGES", "Select one to three distinct, one-based pages from a PDF.");
      const source = await PDFDocument.load(bytes);
      if (pages.some(p => p > source.getPageCount()))
        throw new DomainError(422, "INVALID_SOURCE_PAGES", "A requested source page does not exist.");
      const subset = await PDFDocument.create();
      for (const page of await subset.copyPages(source, pages.map(p => p - 1))) subset.addPage(page);
      selected = Buffer.from(await subset.save());
      this.signal.throwIfAborted();
    }
    // PDF parsing/copying can yield after the invocation loses ownership.
    await this.reserve?.(0, 0);
    this.signal.throwIfAborted();
    const mapping = pages?.length ? { source_page_numbers: [...pages] } : {};
    this.inspected.push({ artifact_id: id, content_hash: artifact.content_hash, ...mapping });
    return { artifact_id: id, name: artifact.display_name, media_type: artifact.media_type, bytes: selected, ...mapping };
  };
}
