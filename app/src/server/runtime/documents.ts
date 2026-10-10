import { DomainError } from "../../domain/errors";
import type { Database } from "../database";
import { ArtifactService } from "../artifacts/service";
export interface ReasoningDocument {
  artifact_id: string;
  name: string;
  media_type: string;
  bytes: Buffer;
  source_page_numbers?: number[];
}
// Resolve only source artifacts captured for this exact run. Generated code supplies IDs, never URLs or paths.
export async function documentsForRun(
  db: Database,
  runId: string,
  ids: string[],
  artifacts = new ArtifactService(db),
): Promise<ReasoningDocument[]> {
  if (!ids.length) return [];
  const run = (
    await db.query(
      "SELECT workflow_id,input_bundle_id FROM workflow_runs WHERE id=$1",
      [runId],
    )
  ).rows[0];
  if (!run)
    throw new DomainError(
      422,
      "DOCUMENT_ACCESS_DENIED",
      "Captured run not found.",
    );
  return documentsForBundle(
    db,
    String(run.workflow_id),
    String(run.input_bundle_id),
    ids,
    artifacts,
  );
}
export async function documentsForBundle(
  db: Database,
  workflowId: string,
  bundleId: string,
  ids: string[],
  artifacts = new ArtifactService(db),
): Promise<ReasoningDocument[]> {
  if (!ids.length) return [];
  const row = (
    await db.query(
      "SELECT workflow_id,manifest FROM input_bundles WHERE workflow_id=$1 AND id=$2",
      [workflowId, bundleId],
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
      "Reasoning may read up to 20 distinct documents captured for this input bundle.",
    );
  const result: ReasoningDocument[] = [];
  let total = 0;
  for (const id of ids) {
    const { artifact, bytes } = await artifacts.read(
      String(row.workflow_id),
      id,
    );
    if (artifact.metadata?.capture_status === "unavailable")
      throw new DomainError(
        422,
        "CAPTURED_DOCUMENT_UNAVAILABLE",
        `The attachment “${artifact.display_name}” was not downloaded. Consult the captured failure reason; do not treat it as empty or verified evidence.`,
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
