import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Artifact } from "../src/domain/engineering";
import { RepairDocumentReader } from "../src/server/repairs/documents";
import { inputInventory } from "../src/server/repairs/evidence";

function reader(bytes = Buffer.from("%PDF-1.7\nfixture"), media = "application/pdf", kind = "source_document") {
  const id = randomUUID(), workflowId = randomUUID();
  const artifact: Artifact = { id, workflow_id: workflowId, kind, state: "ready", storage_backend: "local", storage_key: "fixture", content_hash: "fixture-hash", byte_size: bytes.length, media_type: media, display_name: "fixture.pdf", metadata: {} };
  const read = vi.fn(async () => ({ artifact, bytes }));
  const controller = new AbortController();
  const documents = new RepairDocumentReader(workflowId, new Set([id]), { read }, controller.signal);
  return { id, workflowId, read, controller, documents };
}

it("reads captured evidence under the workflow owner and rejects an uncaptured ID before storage access", async () => {
  const r = reader();
  await expect(r.documents.read(randomUUID())).rejects.toMatchObject({ code: "DOCUMENT_ACCESS_DENIED" });
  expect(r.read).not.toHaveBeenCalled();
  expect((await r.documents.read(r.id)).bytes.toString()).toContain("%PDF-");
  expect(r.read).toHaveBeenCalledWith(r.workflowId, r.id);
  expect(r.documents.inspected).toEqual([{ artifact_id: r.id, content_hash: "fixture-hash" }]);
});

it("bounds concurrent calls and accumulated document bytes", async () => {
  const r = reader();
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => r.documents.read(r.id)));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(3);
  expect(r.read).toHaveBeenCalledTimes(3);
  const large = Buffer.alloc(11 * 1024 * 1024);
  large.write("%PDF-1.7");
  const b = reader(large);
  await b.documents.read(b.id);
  await expect(b.documents.read(b.id)).rejects.toMatchObject({ code: "DOCUMENT_CONTEXT_TOO_LARGE" });
  expect(b.documents.inspected).toHaveLength(1);
});

it("rejects unsupported/generated artifacts, malformed PDFs, oversized text and cancelled reads", async () => {
  for (const [bytes, media, kind, code] of [
    [Buffer.from("code"), "text/plain", "generated_project", "UNSUPPORTED_DOCUMENT"],
    [Buffer.from("not a PDF"), "application/pdf", "source_document", "INVALID_DOCUMENT"],
    [Buffer.alloc(200001), "text/plain", "source_document", "DOCUMENT_CONTEXT_TOO_LARGE"],
  ] as const) {
    const r = reader(bytes, media, kind);
    await expect(r.documents.read(r.id)).rejects.toMatchObject({ code });
    expect(r.documents.inspected).toHaveLength(0);
  }
  const r = reader(); r.controller.abort();
  await expect(r.documents.read(r.id)).rejects.toThrow();
  expect(r.read).not.toHaveBeenCalled();
});

it("never authorizes a document solely because arbitrary input JSON mentions it", () => {
  const captured = randomUUID(), unrelated = randomUUID();
  const inventory = inputInventory([{ id: randomUUID(), manifest: {
    artifacts: [{ artifact_id: captured }],
    input: { documents: [{ artifact_id: captured, name: "captured.pdf" }, { artifact_id: unrelated, name: "uncaptured.pdf" }] },
  } }]);
  expect(inventory[0].documents.map(d => d.artifact_id)).toEqual([captured]);
});
