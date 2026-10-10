import type { GmailReader } from "../../domain/gmail";
import { CAPTURE_LIMITS } from "../../domain/gmail-capture";
import { DomainError } from "../../domain/errors";
import type { Database } from "../database";
import { ArtifactService } from "../artifacts/service";
import { BundleService } from "../runtime/bundle-service";
import { CaptureCheckpoints, type CaptureItem } from "./capture-checkpoints";
// Each pool drains before returning an error, so no unobserved downloads keep
// writing after an activity failure. The first failure cancels sibling requests.
async function pool<T>(
  items: T[],
  width: number,
  signal: AbortSignal,
  fn: (item: T, signal: AbortSignal) => Promise<void>,
) {
  const stop = new AbortController(),
    combined = AbortSignal.any([signal, stop.signal]);
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        combined.throwIfAborted();
        const item = items[next++];
        try {
          await fn(item, combined);
        } catch (error) {
          stop.abort(error);
          throw error;
        }
      }
    }),
  );
  const failure = results.find((r) => r.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  signal.throwIfAborted();
}
const safeName = (name: string) =>
  name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 300) || "attachment";
export class GroupedGmailCapture {
  constructor(
    private db: Database,
    private reader: GmailReader,
    private artifacts = new ArtifactService(db),
    private options: { concurrency?: number; requestTimeoutMs?: number } = {},
  ) {}
  private async request<T>(
    signal: AbortSignal,
    read: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const timeout = AbortSignal.timeout(
        this.options.requestTimeoutMs ?? CAPTURE_LIMITS.request_ms,
      );
      try {
        return await read(AbortSignal.any([signal, timeout]));
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof DomainError &&
          [
            "GMAIL_AUTH_REQUIRED",
            "GMAIL_NOT_CONFIGURED",
            "GMAIL_DOWNLOAD_HOST",
          ].includes(error.code)
        )
          throw error;
        last = timeout.aborted
          ? new DomainError(
              504,
              "GMAIL_SOURCE_TIMEOUT",
              "The source download timed out after two attempts.",
            )
          : error;
      }
    }
    throw last;
  }
  async capture(jobId: string, signal: AbortSignal) {
    const checkpoints = new CaptureCheckpoints(this.db, jobId),
      { job, items, bundle: completedBundle } = await checkpoints.read();
    if (completedBundle) return completedBundle;
    const wid = job.workflow_id,
      ids = job.source_request.message_ids as string[];
    if (ids.length > CAPTURE_LIMITS.sources)
      throw new DomainError(
        413,
        "CAPTURE_TOO_LARGE",
        "Select no more than 100 email sources.",
      );
    const saved = new Map(items.map((item) => [item.key, item]));
    const persist = async (item: CaptureItem, s: AbortSignal) => {
      s.throwIfAborted();
      const stored = await checkpoints.save(item);
      saved.set(stored.key, stored);
      await checkpoints.progress();
    };
    await checkpoints.progress();
    const width = Math.max(
      1,
      Math.min(
        CAPTURE_LIMITS.concurrency,
        this.options.concurrency ?? CAPTURE_LIMITS.concurrency,
      ),
    );
    await pool(ids, width, signal, async (id, s) => {
      const key = JSON.stringify([id]);
      if (saved.has(key)) return;
      let message;
      try {
        message = await this.request(s, (requestSignal) =>
          this.reader.message(id, requestSignal),
        );
      } catch (error) {
        s.throwIfAborted();
        if (
          error instanceof DomainError &&
          error.code === "GMAIL_AUTH_REQUIRED"
        )
          throw error;
        throw new DomainError(
          502,
          "GMAIL_CAPTURE_FAILED",
          `Could not capture email ${id}. Completed downloads are retained. Check Gmail access or try a smaller selection.`,
        );
      }
      if (message.id !== id)
        throw new DomainError(
          422,
          "GMAIL_MESSAGE_CHANGED",
          "The email identity changed during capture.",
        );
      if (
        Buffer.byteLength(message.text) > 150_000 ||
        message.attachments.length > CAPTURE_LIMITS.attachments ||
        new Set(message.attachments.map((a) => a.id)).size !==
          message.attachments.length
      )
        throw new DomainError(
          413,
          "CAPTURE_TOO_LARGE",
          "An email exceeds the text or attachment capture limits.",
        );
      s.throwIfAborted();
      const source = await this.artifacts.create(
        wid,
        "source_document",
        `email-${id}.json`,
        "application/json",
        Buffer.from(JSON.stringify(message)),
        { source: "gmail", message_id: id },
      );
      await persist(
        {
          key,
          kind: "message",
          ref: {
            artifact_id: source.id,
            message_id: id,
            name: source.display_name,
          },
          data: { ...message, source_artifact_id: source.id },
        },
        s,
      );
    });
    const messages = ids
      .map((id) => saved.get(JSON.stringify([id]))!)
      .filter((i) => i.kind === "message");
    const attachments = messages.flatMap((m) =>
      m.data.attachments.map((a) => ({ id: m.data.id, attachment: a })),
    );
    if (
      attachments.length > CAPTURE_LIMITS.attachments ||
      attachments.length + ids.length > CAPTURE_LIMITS.sources
    )
      throw new DomainError(
        413,
        "CAPTURE_TOO_LARGE",
        "Select fewer emails: capture supports 100 sources including at most 90 attachments.",
      );
    await pool(attachments, width, signal, async ({ id, attachment }, s) => {
      const key = JSON.stringify([id, attachment.id]);
      if (saved.has(key)) return;
      const name = safeName(attachment.name);
      let content: Buffer,
        unavailable: { code: string; reason: string } | undefined;
      try {
        content = await this.request(s, (requestSignal) =>
          this.reader.attachment(id, attachment, requestSignal),
        );
      } catch (error) {
        s.throwIfAborted();
        if (
          error instanceof DomainError &&
          [
            "GMAIL_AUTH_REQUIRED",
            "GMAIL_NOT_CONFIGURED",
            "GMAIL_DOWNLOAD_HOST",
          ].includes(error.code)
        )
          throw error;
        unavailable = {
          code:
            error instanceof DomainError &&
            error.code === "GMAIL_SOURCE_TIMEOUT"
              ? error.code
              : "GMAIL_ATTACHMENT_UNAVAILABLE",
          reason:
            error instanceof DomainError &&
            error.code === "GMAIL_SOURCE_TIMEOUT"
              ? "Attachment download timed out after two attempts."
              : "Attachment could not be downloaded after two attempts.",
        };
        content = Buffer.from(
          JSON.stringify({
            message_id: id,
            attachment_id: attachment.id,
            name,
            capture_status: "unavailable",
            capture_error: unavailable,
          }),
        );
      }
      s.throwIfAborted();
      if (content.length > 25 * 1024 * 1024)
        throw new DomainError(
          413,
          "CAPTURE_TOO_LARGE",
          "An attachment exceeds the 25 MB capture limit. Select a smaller file.",
        );
      const artifact = await this.artifacts.create(
        wid,
        "source_document",
        name,
        unavailable ? "application/json" : attachment.media_type,
        content,
        {
          source: "gmail",
          message_id: id,
          attachment_id: attachment.id,
          ...(unavailable
            ? { capture_status: "unavailable", capture_error: unavailable }
            : {}),
        },
      );
      await persist(
        {
          key,
          kind: "document",
          ref: { artifact_id: artifact.id, message_id: id, name },
          data: {
            artifact_id: artifact.id,
            message_id: id,
            name,
            media_type: artifact.media_type,
            byte_size: artifact.byte_size!,
            sha256: artifact.content_hash!,
            capture_status: unavailable ? "unavailable" : "ready",
            ...(unavailable ? { capture_error: unavailable } : {}),
          },
        },
        s,
      );
    });
    const documents = attachments
      .map(
        ({ id, attachment }) => saved.get(JSON.stringify([id, attachment.id]))!,
      )
      .filter((i) => i.kind === "document");
    if (
      documents.reduce((n, d) => n + d.data.byte_size, 0) > CAPTURE_LIMITS.bytes
    )
      throw new DomainError(
        413,
        "CAPTURE_TOO_LARGE",
        "This packet exceeds 50 MB. Select fewer emails.",
      );
    signal.throwIfAborted();
    // Recheck ownership and atomically publish only after every source is either
    // captured or explicitly unavailable. Cancellation never creates a runnable bundle.
    return this.db.transaction(async (tx) => {
      await checkpoints.owner(tx);
      signal.throwIfAborted();
      const prior = (
        await tx.query(
          "SELECT input_bundle_id FROM grouped_executions WHERE job_id=$1",
          [jobId],
        )
      ).rows[0];
      if (prior.input_bundle_id)
        return (
          await tx.query("SELECT * FROM input_bundles WHERE id=$1", [
            prior.input_bundle_id,
          ])
        ).rows[0];
      const bundle = await new BundleService(this.db).createInTransaction(
        tx,
        wid,
        {
          source_kind: "gmail",
          shipment_reference: null,
          manifest: {
            input: {
              messages: messages.map((m) => ({
                ...m.data,
                attachment_failures: documents
                  .filter(
                    (d) =>
                      d.data.message_id === m.data.id && d.data.capture_error,
                  )
                  .map((d) => ({
                    name: d.data.name,
                    attachment_id: JSON.parse(d.key)[1],
                    ...d.data.capture_error!,
                  })),
              })),
              documents: documents.map((d) => d.data),
            },
            message_ids: ids,
            artifacts: [...messages, ...documents].map((i) => i.ref),
          },
        },
      );
      signal.throwIfAborted();
      await tx.query(
        "UPDATE grouped_executions SET input_bundle_id=$2 WHERE job_id=$1",
        [jobId, bundle.id],
      );
      await tx.query(
        "UPDATE workflow_jobs SET phase='grouping selected sources',updated_at=now() WHERE id=$1",
        [jobId],
      );
      return bundle;
    });
  }
}
