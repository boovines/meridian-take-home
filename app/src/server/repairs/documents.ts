import { DomainError } from "../../domain/errors";
import type { ArtifactService } from "../artifacts/service";
import type { ReasoningDocument } from "../runtime/documents";

export type ReadRepairDocument = (id: string) => Promise<ReasoningDocument>;

// Attempt-scoped evidence access. The caller builds the allowlist from locked
// workflow cases, never from model-supplied paths, URLs, or workflow identifiers.
export class RepairDocumentReader {
  private calls = 0;
  private bytes = 0;
  readonly inspected: { artifact_id: string; content_hash: string | null }[] = [];
  constructor(
    private workflowId: string,
    private allowed: ReadonlySet<string>,
    private artifacts: Pick<ArtifactService, "read">,
    private signal: AbortSignal,
  ) {}

  read: ReadRepairDocument = async (id) => {
    this.signal.throwIfAborted();
    if (++this.calls > 3)
      throw new DomainError(422, "REPAIR_DOCUMENT_LIMIT", "Inspect at most three source documents per repair attempt.");
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
    this.inspected.push({ artifact_id: id, content_hash: artifact.content_hash });
    return { artifact_id: id, name: artifact.display_name, media_type: artifact.media_type, bytes };
  };
}
