import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { LocalObjectStore } from "../src/server/artifacts/storage";
import { ArtifactService } from "../src/server/artifacts/service";
import { BundleService } from "../src/server/runtime/bundle-service";
import { RunService } from "../src/server/runtime/run-service";
import { CanvasService } from "../src/server/canvas/service";
import { GmailGroupingService } from "../src/server/inputs/gmail-grouping";
import { GmailCaptureService } from "../src/server/inputs/gmail-capture";
import {
  ComposioGmail,
  attachmentUrl,
  boundedBytes,
} from "../src/server/integrations/composio-gmail";
import { documentsForRun } from "../src/server/runtime/documents";
import { invocationFailure } from "../src/server/runtime/invoke-step";
import { gmailCapture, type GmailReader } from "../src/domain/gmail";
import { runtimeFixture } from "./fixtures/runtime";
let db: Database, artifacts: ArtifactService, directory: string;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (
    url &&
    !["localhost", "127.0.0.1", "postgres"].includes(new URL(url).hostname)
  )
    throw new Error("Use isolated local/CI persistence.");
  db = await createDatabase(url);
  await migrate(db);
  directory = await mkdtemp(path.join(os.tmpdir(), "meridian-gmail-"));
  artifacts = new ArtifactService(db, new LocalObjectStore(directory));
});
afterAll(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const messageId = "1234567890abcdef";
function reader(): GmailReader {
  return {
    search: async () => ({ messages: [], next_page_token: null }),
    message: async (id) => ({
      id,
      thread_id: "thread",
      subject: "Shipment DEMO-1",
      sender: "supplier@example.test",
      received_at: "2026-01-01T00:00:00Z",
      text: "Attached packet",
      attachments: [
        {
          id: "attachment",
          name: "../invoice.pdf",
          media_type: "application/pdf",
        },
      ],
    }),
    attachment: async () => Buffer.from("%PDF-1.7\nfixture document"),
  };
}
it("uses only read-only Composio tools with the connected account user and no credentials on downloads", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const request = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/connected_accounts/"))
        return Response.json({
          user_id: "demo-user",
          status: "ACTIVE",
          state: { ignored: "credential" },
        });
      if (url.endsWith("GMAIL_FETCH_EMAILS"))
        return Response.json({
          successful: true,
          data: {
            messages: [{ messageId, subject: "Packet" }],
            nextPageToken: "next",
          },
        });
      if (url.endsWith("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"))
        return Response.json({
          successful: true,
          data: {
            messageId,
            attachmentList: [
              {
                attachmentId: "a",
                filename: "x.pdf",
                mimeType: "application/pdf",
              },
            ],
          },
        });
      if (url.endsWith("GMAIL_GET_ATTACHMENT"))
        return Response.json({
          successful: true,
          data: {
            file: {
              s3url:
                "https://temp.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/file?signature=private",
            },
          },
        });
      return new Response("%PDF-content");
    },
  ) as typeof fetch;
  const gmail = new ComposioGmail(
      { key: "fixture-key", account: "fixture-account" },
      request,
    ),
    signal = AbortSignal.timeout(10000);
  expect(await gmail.search("shipment", undefined, signal)).toMatchObject({
    next_page_token: "next",
    messages: [{ id: messageId }],
  });
  const m = await gmail.message(messageId, signal);
  expect(
    (await gmail.attachment(messageId, m.attachments[0], signal)).toString(),
  ).toBe("%PDF-content");
  expect(
    requests.filter((r) => r.url.includes("connected_accounts")),
  ).toHaveLength(1);
  const execution = JSON.parse(String(requests[1].init?.body));
  expect(execution).toMatchObject({
    user_id: "demo-user",
    connected_account_id: "fixture-account",
    version: "20260915_00",
    arguments: { user_id: "me" },
  });
  expect(requests.at(-1)?.init?.headers).toBeUndefined();
  expect(requests.at(-1)?.init?.redirect).toBe("error");
});
it("rejects unexpected download destinations, oversized streams, and provider failure without leaking its body", async () => {
  for (const url of [
    "http://localhost/file",
    "https://127.0.0.1/file",
    "https://example.test/file",
    "https://temp.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com.evil.test/file",
  ])
    expect(() => attachmentUrl(url)).toThrow();
  await expect(
    boundedBytes(new Response("long payload"), 4),
  ).rejects.toMatchObject({ code: "DOCUMENT_TOO_LARGE" });
  const gmail = new ComposioGmail(
    { key: "fixture", account: "fixture" },
    vi.fn(
      async () => new Response("private token", { status: 401 }),
    ) as typeof fetch,
  );
  await expect(
    gmail.search("", undefined, AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ code: "GMAIL_AUTH_REQUIRED" });
});
it("captures immutable message and attachment evidence and never publishes a partial bundle", async () => {
  const w = await new CanvasService(db).create({
    name: "Capture",
    desired_outcome: "Read a packet",
  });
  const captured = await new GmailCaptureService(
    db,
    reader(),
    artifacts,
  ).capture(
    w.id,
    { message_ids: [messageId], shipment_reference: "DEMO-1" },
    AbortSignal.timeout(10000),
  );
  const manifest = captured.manifest as {
    artifacts: { artifact_id: string }[];
    input: { documents: { name: string }[] };
  };
  expect(manifest.artifacts).toHaveLength(2);
  expect(manifest.input.documents[0].name).toBe(".._invoice.pdf");
  expect(
    (
      await artifacts.read(w.id, manifest.artifacts[1].artifact_id)
    ).bytes.toString(),
  ).toContain("%PDF");
  await expect(
    db.query("UPDATE input_bundles SET manifest='{}' WHERE id=$1", [
      captured.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  const failing = reader();
  failing.attachment = async () => {
    throw new Error("download interrupted");
  };
  await expect(
    new GmailCaptureService(db, failing, artifacts).capture(
      w.id,
      { message_ids: [messageId], shipment_reference: "DEMO-2" },
      AbortSignal.timeout(10000),
    ),
  ).rejects.toThrow("download interrupted");
  expect(await new BundleService(db).list(w.id)).toHaveLength(1);
});
it("scopes document reasoning to the run's captured inputs, preserving unsupported inputs without interpreting them", async () => {
  const f = await runtimeFixture(db, artifacts, ["trigger", "outcome"]);
  await f.runs.finish(f.job.id, { status: "failed" });
  const pdf = await artifacts.create(
    f.w.id,
    "source_document",
    "invoice.pdf",
    "application/pdf",
    Buffer.from("%PDF-1.7\nfixture"),
  );
  const sheet = await artifacts.create(
    f.w.id,
    "source_document",
    "list.xls",
    "application/vnd.ms-excel",
    Buffer.from("fixture"),
  );
  const other = await artifacts.create(
    f.w.id,
    "source_document",
    "other.pdf",
    "application/pdf",
    Buffer.from("%PDF-other"),
  );
  const bundle = await new BundleService(db).create(f.w.id, {
    source_kind: "gmail",
    shipment_reference: "DEMO",
    manifest: {
      input: {},
      message_ids: [messageId],
      artifacts: [pdf, sheet].map((a) => ({
        artifact_id: a.id,
        name: a.display_name,
        message_id: messageId,
      })),
    },
  });
  const { run } = await new RunService(db).start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    input_bundle_id: String(bundle.id),
    rerun_of_id: null,
  });
  expect(
    (
      await documentsForRun(db, run.id, [pdf.id], artifacts)
    )[0].bytes.toString(),
  ).toContain("%PDF");
  await expect(
    documentsForRun(db, run.id, [other.id], artifacts),
  ).rejects.toMatchObject({ code: "DOCUMENT_ACCESS_DENIED" });
  await expect(
    documentsForRun(db, run.id, [pdf.id, pdf.id], artifacts),
  ).rejects.toMatchObject({ code: "DOCUMENT_ACCESS_DENIED" });
  const unsupported = await documentsForRun(db, run.id, [sheet.id], artifacts)
    .catch((error) => error);
  expect(invocationFailure(unsupported)).toMatchObject({
    code: "UNSUPPORTED_DOCUMENT",
    category: "implementation",
  });
  // A repaired selector can use the supported evidence without changing inputs.
  expect(await documentsForRun(db, run.id, [pdf.id], artifacts)).toHaveLength(1);
});
it("supplies captured bytes to the approved Agent broker and returns only its JSON result to generated code", async () => {
  const { invokeApprovedStep } = await import(
    "../src/server/runtime/invoke-step"
  );
  const f = await runtimeFixture(db, artifacts, ["trigger", "outcome"]);
  const { VersionService } = await import(
    "../src/server/engineering/version-service"
  );
  const { project } = await new VersionService(db, artifacts).load(
    f.w.id,
    f.version.id,
  );
  const id = randomUUID(),
    pdf = {
      artifact_id: id,
      name: "invoice.pdf",
      media_type: "application/pdf",
      bytes: Buffer.from("%PDF-fixture"),
    };
  const load = vi.fn(async () => [pdf]);
  const reason = vi.fn(async () => ({ invoice: "DEMO-1" }));
  const invoke = vi.fn(async (_project, _node, context) =>
    context.tool_result
      ? {
          kind: "complete",
          output: context.tool_result,
          matching_connection_ids: [],
        }
      : {
          kind: "reason",
          instructions: "Extract invoice",
          data: {},
          document_ids: [id],
        },
  );
  const signal = AbortSignal.timeout(10000);
  expect(
    await invokeApprovedStep(
      project,
      f.nodes[0].id,
      "agent",
      { input: {} },
      { invoke, reason },
      signal,
      load,
    ),
  ).toMatchObject({ kind: "complete", output: { invoice: "DEMO-1" } });
  expect(load).toHaveBeenCalledWith([id]);
  expect(reason).toHaveBeenCalledWith("Extract invoice", {}, signal, [pdf]);
  expect(invoke.mock.calls[1][2]).toEqual({
    input: {},
    tool_result: { invoice: "DEMO-1" },
  });
  await expect(
    invokeApprovedStep(
      project,
      f.nodes[0].id,
      "code",
      { input: {} },
      { invoke, reason },
      signal,
      load,
    ),
  ).rejects.toMatchObject({ code: "METHOD_VIOLATION" });
  expect(reason).toHaveBeenCalledTimes(1);
});

it("accepts more than ten emails without allowing duplicate selections", () => {
  const ids = Array.from({ length: 14 }, (_, i) => i.toString(16).padStart(16, "0"));
  expect(gmailCapture.parse({ message_ids: ids, shipment_reference: "DEMO" }).message_ids).toHaveLength(14);
  expect(gmailCapture.safeParse({ message_ids: [...ids, ids[0]], shipment_reference: "DEMO" }).success).toBe(false);
});

it("prepares source-backed packets without downloading attachments or publishing bundles", async () => {
  const w = await new CanvasService(db).create({ name: "Packet preparation", desired_outcome: "One request per packet" });
  const source = reader();
  source.message = async (id) => ({ id, thread_id: id, subject: "Request", sender: "demo@example.test", received_at: "", text: "Reference DEMO-123", attachments: [] });
  source.attachment = vi.fn(async () => { throw new Error("Preparation must not read attachments"); });
  const service = new GmailGroupingService(db, source, async () => ({ groups: [{ reference: "DEMO-123", message_ids: [messageId], evidence: { message_id: messageId, quote: "Reference DEMO-123" }, reason: "Explicit reference" }], unresolved: [] }));
  const result = await service.prepare(w.id, {message_ids:[messageId]}, AbortSignal.timeout(10000));
  expect(result.groups[0].reference).toBe("DEMO-123");
  expect(source.attachment).not.toHaveBeenCalled();
  expect((await db.query("SELECT id FROM input_bundles WHERE workflow_id=$1",[w.id])).rows).toHaveLength(0);
});

it("captures every selected email beyond ten without omitting attachments", async () => {
  const workflow = await new CanvasService(db).create({
    name: "Full selection",
    desired_outcome: "Capture all selected messages.",
  });
  const ids = Array.from(
    { length: 12 },
    (_, i) => `abcdef0123${i.toString(16).padStart(2, "0")}`,
  );
  const capture = new GmailCaptureService(db, reader(), artifacts);
  const bundle = await capture.captureSelection(
    workflow.id,
    ids,
    AbortSignal.timeout(10000),
  );
  const saved = await new BundleService(db).read(
    workflow.id,
    String(bundle.id),
  );
  expect(saved.manifest).toMatchObject({
    message_ids: ids,
    input: {
      messages: ids.map((id) => ({ id })),
      documents: ids.map((id) => ({ message_id: id })),
    },
  });
});
