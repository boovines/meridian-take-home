import { randomUUID, createHash } from "node:crypto";
import { DomainError } from "../../domain/canvas";
import type { Artifact } from "../../domain/engineering";
import type { Database } from "../database";
import { objectStore, type ObjectStore } from "./storage";
function artifact(row: Record<string, unknown>): Artifact {
  return {
    ...row,
    byte_size: row.byte_size === null ? null : Number(row.byte_size),
  } as Artifact;
}
export class ArtifactService {
  constructor(
    private db: Database,
    private store?: ObjectStore,
  ) {}
  async create(
    workflowId: string,
    kind: string,
    displayName: string,
    mediaType: string,
    bytes: Buffer,
    metadata: Record<string, unknown> = {},
  ) {
    if (bytes.length > 25 * 1024 * 1024)
      throw new DomainError(
        413,
        "ARTIFACT_TOO_LARGE",
        "This file exceeds the 25 MB demo limit.",
      );
    const store = this.store || objectStore(),
      id = randomUUID(),
      key = `${workflowId}/${id}/payload`,
      hash = createHash("sha256").update(bytes).digest("hex");
    await this.db.query(
      "INSERT INTO artifacts(id,workflow_id,kind,storage_backend,storage_key,media_type,display_name,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        workflowId,
        kind,
        store.backend,
        key,
        mediaType,
        displayName,
        metadata,
      ],
    );
    try {
      await store.write(key, bytes, mediaType);
      const saved = await store.read(key);
      if (
        saved.length !== bytes.length ||
        createHash("sha256").update(saved).digest("hex") !== hash
      )
        throw new Error("Artifact integrity check failed.");
      return artifact(
        (
          await this.db.query(
            "UPDATE artifacts SET state='ready',content_hash=$2,byte_size=$3,ready_at=now() WHERE id=$1 AND state='pending' RETURNING *",
            [id, hash, bytes.length],
          )
        ).rows[0],
      );
    } catch (error) {
      await this.db.query(
        "UPDATE artifacts SET state='failed' WHERE id=$1 AND state='pending'",
        [id],
      );
      throw error;
    }
  }
  async read(workflowId: string, id: string) {
    const row = (
      await this.db.query(
        "SELECT * FROM artifacts WHERE workflow_id=$1 AND id=$2",
        [workflowId, id],
      )
    ).rows[0];
    if (!row) throw new DomainError(404, "NOT_FOUND", "Artifact not found.");
    const record = artifact(row);
    if (record.state !== "ready")
      throw new DomainError(
        409,
        "ARTIFACT_NOT_READY",
        "The file is not ready.",
      );
    const bytes = await (
      this.store || objectStore(record.storage_backend)
    ).read(record.storage_key);
    if (
      bytes.length !== record.byte_size ||
      createHash("sha256").update(bytes).digest("hex") !== record.content_hash
    )
      throw new DomainError(
        409,
        "ARTIFACT_CHANGED",
        "Stored file contents do not match the recorded version.",
      );
    return { artifact: record, bytes };
  }
}
