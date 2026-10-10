import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { ArtifactService } from "../src/server/artifacts/service";
import { LocalObjectStore } from "../src/server/artifacts/storage";
import { GroupedExecutionService } from "../src/server/grouped-execution/service";
import { GroupedGmailCapture } from "../src/server/inputs/grouped-gmail-capture";
import {
  sourcesForCapture,
  childManifest,
} from "../src/server/grouped-execution/sources";
import { bundleInput } from "../src/domain/runtime";
import type { GmailReader } from "../src/domain/gmail";
import { runtimeFixture } from "./fixtures/runtime";
let db: Database, artifacts: ArtifactService, directory: string;
beforeAll(async () => {
  db = await createDatabase(process.env.TEST_DATABASE_URL);
  await migrate(db);
  directory = await mkdtemp(path.join(os.tmpdir(), "meridian-capture-"));
  artifacts = new ArtifactService(db, new LocalObjectStore(directory));
});
afterAll(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const ids = ["abcdef0123456789", "abcdef0123456780"];
function reader(): GmailReader {
  return {
    search: async () => ({ messages: [], next_page_token: null }),
    message: vi.fn(async (id) => ({
      id,
      thread_id: id,
      subject: "Fwd: PO",
      sender: "supplier@example.test",
      received_at: "2026-01-01",
      text: "Order 3 widgets",
      attachments: [
        { id: "a", name: "order.pdf", media_type: "application/pdf" },
      ],
    })),
    attachment: vi.fn(async () => Buffer.from("%PDF-1.7 fixture")),
  };
}
async function fixture(messageIds = ids) {
  const f = await runtimeFixture(db, artifacts, ["trigger", "outcome"]);
  await f.runs.finish(f.job.id, { status: "cancelled", error: null });
  const service = new GroupedExecutionService(db);
  const job = await service.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    message_ids: messageIds,
  });
  return { ...f, service, parent: job };
}
it("resumes saved sources after interruption without fetching them again", async () => {
  const f = await fixture(),
    r = reader(),
    controller = new AbortController();
  let interrupted = false;
  r.attachment = vi.fn(async (id) => {
    if (id === ids[1] && !interrupted) {
      interrupted = true;
      controller.abort();
      throw controller.signal.reason;
    }
    return Buffer.from("%PDF-1.7 fixture");
  });
  const capture = new GroupedGmailCapture(db, r, artifacts, {
    concurrency: 1,
    requestTimeoutMs: 1000,
  });
  await expect(
    capture.capture(f.parent.id, controller.signal),
  ).rejects.toThrow();
  expect(
    (await f.service.read(f.w.id, f.parent.id)).record.input_bundle_id,
  ).toBeNull();
  const calls = vi.mocked(r.message).mock.calls.length;
  const bundle = await capture.capture(f.parent.id, AbortSignal.timeout(10000));
  expect(vi.mocked(r.message).mock.calls.length).toBe(calls);
  expect(
    vi.mocked(r.attachment).mock.calls.filter((c) => c[0] === ids[0]),
  ).toHaveLength(1);
  expect(
    sourcesForCapture(bundleInput.shape.manifest.parse(bundle.manifest)),
  ).toHaveLength(4);
  await f.service.attachCapture(f.parent.id, String(bundle.id));
  expect(
    (await f.service.read(f.w.id, f.parent.id)).job.progress.capture,
  ).toMatchObject({
    messages_completed: 2,
    attachments_completed: 2,
    attachments_unavailable: 0,
  });
});
it("records timed-out attachments as unavailable evidence and preserves them in child inputs", async () => {
  const f = await fixture([ids[0]]),
    r = reader();
  r.attachment = vi.fn(
    async (_id, _a, signal) =>
      new Promise<Buffer>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      ),
  );
  const bundle = await new GroupedGmailCapture(db, r, artifacts, {
    requestTimeoutMs: 10,
  }).capture(f.parent.id, AbortSignal.timeout(10000));
  expect(r.attachment).toHaveBeenCalledTimes(2);
  const manifest = bundleInput.shape.manifest.parse(bundle.manifest);
  const sources = sourcesForCapture(manifest);
  expect(sources).toHaveLength(2);
  const child = childManifest(
    manifest,
    {
      groups: [{ key: "email", label: "Email", context: {} }],
      assignments: sources.map((s) => ({
        source_id: s.id,
        targets: [
          {
            group_key: "email",
            scope: "Entire email",
            reason: "Owned attachment",
          },
        ],
        unresolved: null,
        exclusion_reason: null,
      })),
    },
    "email",
    randomUUID(),
  );
  expect(child.input).toMatchObject({
    documents: [
      {
        capture_status: "unavailable",
        capture_error: { code: "GMAIL_SOURCE_TIMEOUT" },
      },
    ],
    messages: [{ attachment_failures: [{ name: "order.pdf" }] }],
  });
  const state = await f.service.read(f.w.id, f.parent.id);
  expect(state.job.progress.capture).toMatchObject({
    attachments_unavailable: 1,
    warnings: [{ name: "order.pdf" }],
  });
});
it("bounds parallel downloads and never publishes after cancellation", async () => {
  const f = await fixture(),
    r = reader(),
    c = new AbortController();
  let active = 0,
    peak = 0;
  r.attachment = vi.fn(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    c.abort();
    return Buffer.from("%PDF");
  });
  await expect(
    new GroupedGmailCapture(db, r, artifacts, { concurrency: 2 }).capture(
      f.parent.id,
      c.signal,
    ),
  ).rejects.toThrow();
  expect(peak).toBe(2);
  expect(
    (
      await db.query(
        "SELECT id FROM input_bundles WHERE workflow_id=$1 AND source_kind='gmail'",
        [f.w.id],
      )
    ).rows,
  ).toHaveLength(0);
});
it("stops on Gmail authorization failure instead of publishing unavailable placeholders", async () => {
  const { DomainError } = await import("../src/domain/errors");
  const f = await fixture([ids[0]]),
    r = reader();
  r.attachment = vi.fn(async () => {
    throw new DomainError(401, "GMAIL_AUTH_REQUIRED", "Reconnect Gmail");
  });
  await expect(
    new GroupedGmailCapture(db, r, artifacts).capture(
      f.parent.id,
      AbortSignal.timeout(10000),
    ),
  ).rejects.toMatchObject({ code: "GMAIL_AUTH_REQUIRED" });
  expect(r.attachment).toHaveBeenCalledTimes(1);
  expect(
    (await f.service.read(f.w.id, f.parent.id)).record.input_bundle_id,
  ).toBeNull();
});
it("captures 15 selected emails with bounded parallel downloads and idempotent publication", async () => {
  const selected = Array.from(
    { length: 15 },
    (_, i) => `abcdef012345${i.toString(16).padStart(4, "0")}`,
  );
  const f = await fixture(selected),
    r = reader();
  let active = 0,
    peak = 0;
  r.attachment = vi.fn(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return Buffer.from("%PDF fixture");
  });
  const capture = new GroupedGmailCapture(db, r, artifacts);
  const bundle = await capture.capture(f.parent.id, AbortSignal.timeout(10000));
  expect(peak).toBe(4);
  expect(
    sourcesForCapture(bundleInput.shape.manifest.parse(bundle.manifest)),
  ).toHaveLength(30);
  expect(
    (await capture.capture(f.parent.id, AbortSignal.timeout(10000))).id,
  ).toBe(bundle.id);
  expect(r.attachment).toHaveBeenCalledTimes(15);
});
it("fences a cancelled job even when a download ignores cancellation", async () => {
  const { JobService } = await import("../src/server/engineering/job-service");
  const f = await fixture([ids[0]]),
    r = reader();
  r.attachment = vi.fn(async () => {
    await new JobService(db).requestCancel(f.w.id, f.parent.id);
    return Buffer.from("%PDF fixture");
  });
  await expect(
    new GroupedGmailCapture(db, r, artifacts).capture(
      f.parent.id,
      AbortSignal.timeout(10000),
    ),
  ).rejects.toMatchObject({ code: "GROUP_CANCELLED" });
  expect(
    (await f.service.read(f.w.id, f.parent.id)).record.input_bundle_id,
  ).toBeNull();
});
it("rejects oversized files without publishing a partial input", async () => {
  const f = await fixture([ids[0]]),
    r = reader();
  r.attachment = async () => Buffer.alloc(25 * 1024 * 1024 + 1);
  await expect(
    new GroupedGmailCapture(db, r, artifacts).capture(
      f.parent.id,
      AbortSignal.timeout(10000),
    ),
  ).rejects.toMatchObject({ code: "CAPTURE_TOO_LARGE" });
  expect(
    (await f.service.read(f.w.id, f.parent.id)).record.input_bundle_id,
  ).toBeNull();
});
it("never interprets an unavailable attachment marker as original document bytes", async () => {
  const { documentsForBundle } = await import(
    "../src/server/runtime/documents"
  );
  const { invocationFailure } = await import(
    "../src/server/runtime/invoke-step"
  );
  const f = await fixture([ids[0]]),
    r = reader();
  r.attachment = async () => {
    throw new Error("upstream unavailable");
  };
  const bundle = await new GroupedGmailCapture(db, r, artifacts).capture(
    f.parent.id,
    AbortSignal.timeout(10000),
  );
  const sources = sourcesForCapture(
    bundleInput.shape.manifest.parse(bundle.manifest),
  );
  const id = sources.find((s) => s.kind === "document")!.artifact_id;
  try {
    await documentsForBundle(db, f.w.id, String(bundle.id), [id], artifacts);
    throw new Error("expected failure");
  } catch (error) {
    expect(invocationFailure(error)).toMatchObject({
      code: "CAPTURED_DOCUMENT_UNAVAILABLE",
      category: "input",
    });
  }
});
it("enforces the combined size bound across parallel checkpoints", async () => {
  const f = await fixture([...ids, "abcdef0123456781"]),
    r = reader();
  r.attachment = async () => Buffer.alloc(20 * 1024 * 1024);
  await expect(
    new GroupedGmailCapture(db, r, artifacts).capture(
      f.parent.id,
      AbortSignal.timeout(20000),
    ),
  ).rejects.toMatchObject({ code: "CAPTURE_TOO_LARGE" });
  expect(
    (await f.service.read(f.w.id, f.parent.id)).record.input_bundle_id,
  ).toBeNull();
});
