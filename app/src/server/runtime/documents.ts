import { DomainError } from "../../domain/errors";
import type { Database } from "../database";
import { ArtifactService } from "../artifacts/service";
export interface ReasoningDocument {
  artifact_id: string;
  name: string;
  media_type: string;
  bytes: Buffer;
}
// Resolve only source artifacts captured for this exact run. Generated code supplies IDs, never URLs or paths.
export async function documentsForRun(
  db: Database,
  runId: string,
  ids: string[],
  artifacts = new ArtifactService(db),
): Promise<ReasoningDocument[]> {
  if (!ids.length) return [];
  const row = (
    await db.query(
      "SELECT r.workflow_id,b.manifest FROM workflow_runs r JOIN input_bundles b ON b.id=r.input_bundle_id AND b.workflow_id=r.workflow_id WHERE r.id=$1",
      [runId],
    )
  ).rows[0];
  const manifest = row?.manifest as
    | { artifacts: { artifact_id: string }[] }
    | undefined;
  if (
    !row ||
    !manifest ||
    ids.length > 20 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !manifest.artifacts.some((a) => a.artifact_id === id))
  )
    throw new DomainError(
      422,
      "DOCUMENT_ACCESS_DENIED",
      "Reasoning may read up to 20 distinct documents captured for this run.",
    );
  const result: ReasoningDocument[] = [];
  let total = 0;
  for (const id of ids) {
    const { artifact, bytes } = await artifacts.read(
      String(row.workflow_id),
      id,
    );
    const mime = artifact.media_type;
    if (
      artifact.kind !== "source_document" ||
      ![
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/webp",
        "text/plain",
        "text/csv",
      ].includes(mime)
    )
      throw new DomainError(
        422,
        "UNSUPPORTED_DOCUMENT",
        `The captured document “${artifact.display_name}” cannot be interpreted by this runtime. Use PDF, PNG, JPEG, WebP, plain text, or CSV.`,
      );
    if (
      mime === "application/pdf" &&
      !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))
    )
      throw new DomainError(
        422,
        "INVALID_DOCUMENT",
        `The captured document “${artifact.display_name}” is not a readable PDF.`,
      );
    total += bytes.length;
    if (
      total > 20 * 1024 * 1024 ||
      (mime.startsWith("text/") && bytes.length > 200_000)
    )
      throw new DomainError(
        422,
        "DOCUMENT_CONTEXT_TOO_LARGE",
        "One Agent request supports at most 20 MB of documents and 200 KB per text document.",
      );
    result.push({
      artifact_id: id,
      name: artifact.display_name,
      media_type: mime,
      bytes,
    });
  }
  return result;
}
