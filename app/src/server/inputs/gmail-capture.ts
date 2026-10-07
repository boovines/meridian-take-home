import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import { gmailCapture, type GmailReader } from "../../domain/gmail";
import type { Database } from "../database";
import { ArtifactService } from "../artifacts/service";
import { BundleService } from "../runtime/bundle-service";
import { workflow } from "../workflows/store";
export class GmailCaptureService {
  constructor(
    private db: Database,
    private reader: GmailReader,
    private artifacts = new ArtifactService(db),
  ) {}
  async capture(
    workflowId: string,
    raw: z.infer<typeof gmailCapture>,
    signal: AbortSignal,
  ) {
    const data = gmailCapture.parse(raw);
    await workflow(this.db, workflowId);
    const messages = [],
      documents = [],
      refs = [];
    let bytes = 0;
    for (const id of data.message_ids) {
      signal.throwIfAborted();
      const message = await this.reader.message(id, signal);
      if (
        Buffer.byteLength(message.text) > 150_000 ||
        message.attachments.length + documents.length > 90
      )
        throw new DomainError(
          413,
          "CAPTURE_TOO_LARGE",
          "Select a smaller shipment packet (up to 90 attachments and 150 KB of text per email).",
        );
      // Preserve the original envelope/text and attachment identities as an immutable source artifact.
      const source = await this.artifacts.create(
        workflowId,
        "source_document",
        `email-${id}.json`,
        "application/json",
        Buffer.from(JSON.stringify(message)),
        { source: "gmail", message_id: id },
      );
      refs.push({
        artifact_id: source.id,
        message_id: id,
        name: source.display_name,
      });
      messages.push({
        id,
        subject: message.subject,
        sender: message.sender,
        received_at: message.received_at,
        text: message.text,
        source_artifact_id: source.id,
      });
      for (const attachment of message.attachments) {
        signal.throwIfAborted();
        const content = await this.reader.attachment(id, attachment, signal);
        bytes += content.length;
        if (bytes > 50 * 1024 * 1024)
          throw new DomainError(
            413,
            "CAPTURE_TOO_LARGE",
            "This packet exceeds the 50 MB capture limit. Select fewer emails.",
          );
        const name =
          attachment.name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 300) ||
          "attachment";
        const artifact = await this.artifacts.create(
          workflowId,
          "source_document",
          name,
          attachment.media_type,
          content,
          { source: "gmail", message_id: id, attachment_id: attachment.id },
        );
        refs.push({ artifact_id: artifact.id, message_id: id, name });
        documents.push({
          artifact_id: artifact.id,
          message_id: id,
          name,
          media_type: artifact.media_type,
          byte_size: artifact.byte_size,
          sha256: artifact.content_hash,
        });
      }
    }
    signal.throwIfAborted();
    // A failed download never publishes a partial input bundle. Ready artifacts are retained for diagnosis.
    return new BundleService(this.db).create(workflowId, {
      source_kind: "gmail",
      shipment_reference: data.shipment_reference,
      manifest: {
        input: {
          shipment_reference: data.shipment_reference,
          messages,
          documents,
        },
        message_ids: data.message_ids,
        artifacts: refs,
      },
    });
  }
}
