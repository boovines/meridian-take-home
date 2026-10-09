import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  validateExtraction,
  validateExtractionSchema,
  extractionRequest,
} from "../src/domain/extraction";
import { invokeApprovedStep } from "../src/server/runtime/invoke-step";
import type { Project } from "../src/domain/project";
const artifact = randomUUID();
const request = extractionRequest.parse({
  kind: "extract",
  instructions: "Read the seller and preserve the printed identifier.",
  data: {},
  document_ids: [artifact],
  output_schema: {
    type: "object",
    required: ["seller"],
    properties: { seller: { type: ["string", "null"] } },
    additionalProperties: false,
  },
  critical_paths: [["seller"]],
});
const docs = [{ artifact_id: artifact, page_count: 2 }];
function response(status = "found", value: string | null = "Example Ltd") {
  return {
    data: { seller: value },
    fields: [
      {
        path: ["seller"],
        raw_value: value,
        normalized_value: value,
        status,
        evidence: [
          { artifact_id: artifact, page: 1, text: "Seller: Example Ltd" },
        ],
        explanation:
          status === "found"
            ? null
            : "Checked document header; seller could not be established.",
      },
    ],
  };
}
describe("evidence contract at extraction boundary", () => {
  it("canonicalizes numeric evidence indexes without changing facts or the raw response", () => {
    const req = { ...request, output_schema: { type: "object" }, critical_paths: [["items", "*", "seller"]] };
    const raw = {
      data: { items: [{ seller: "Example Ltd" }] },
      fields: [{ ...response().fields[0], path: ["items", 0, "seller"] }],
    };
    const checked = validateExtraction(req, raw, docs);
    expect(checked.fields[0].path).toEqual(["items", "0", "seller"]);
    expect(checked.data).toEqual(raw.data);
    expect(raw.fields[0].path).toEqual(["items", 0, "seller"]);
    expect(() => validateExtraction(req, {
      ...raw, fields: [...raw.fields, { ...raw.fields[0], path: ["items", "0", "seller"] }],
    }, docs)).toThrow(expect.objectContaining({ code: "EXTRACTION_EVIDENCE_INVALID" }));
    for (const index of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, true, null]) {
      expect(() => validateExtraction(req, {
        ...raw, fields: [{ ...raw.fields[0], path: ["items", index, "seller"] }],
      }, docs)).toThrow(expect.objectContaining({ code: "EXTRACTION_EVIDENCE_INVALID" }));
    }
    expect(() => validateExtraction(req, {
      ...raw, fields: [{ ...raw.fields[0], normalized_value: "Different seller" }],
    }, docs)).toThrow(expect.objectContaining({ code: "EXTRACTION_EVIDENCE_INVALID" }));
  });
  it("rejects asynchronous schemas instead of treating validation promises as success", () => {
    expect(() => validateExtractionSchema({ ...request.output_schema, $async: true }))
      .toThrow(expect.objectContaining({ code: "EXTRACTION_SCHEMA_INVALID" }));
  });
  it("preserves raw identifiers independently of normalized values", () => {
    const r = response("found", "X100");
    r.fields[0].raw_value = "X100A";
    expect(validateExtraction(request, r, docs).fields[0].raw_value).toBe(
      "X100A",
    );
  });
  it("rejects a bare null instead of treating it as proved absence", () => {
    expect(() => validateExtraction(request, null, docs)).toThrow(expect.objectContaining({
      details: { issues: [{ path: [], reason: expect.stringContaining("bare null") }] },
    }));
    expect(() =>
      validateExtraction(request, { data: { seller: null }, fields: [] }, docs),
    ).toThrow(/evidence/i);
  });
  it("records the malformed citation path for repair instead of claiming the response was null", async () => {
    const valid = response();
    const raw = {
      ...valid,
      fields: [{
        ...valid.fields[0],
        evidence: [{ ...valid.fields[0].evidence[0], artifact_id: "message:fixture-email" }],
      }],
    };
    let invocations = 0;
    const events: { kind: string; payload: unknown }[] = [];
    await expect(invokeApprovedStep(
      {} as Project, randomUUID(), "agent", {},
      {
        invoke: async () => { invocations++; return request; },
        reason: async () => ({}),
        extract: async () => raw,
      },
      AbortSignal.timeout(1000),
      async () => [{ artifact_id: artifact, name: "example.txt", media_type: "text/plain", bytes: Buffer.from("Seller: Example Ltd") }],
      async (kind, payload) => { events.push({ kind, payload }); },
    )).rejects.toMatchObject({ code: "EXTRACTION_EVIDENCE_INVALID" });
    expect(invocations).toBe(1);
    expect(events.find(e => e.kind === "failure")?.payload).toMatchObject({
      evidence_issues: { issues: [{
        path: ["fields", "0", "evidence", "0", "artifact_id"],
        reason: expect.stringMatching(/uuid/i),
      }] },
    });
    expect(JSON.stringify(events.find(e => e.kind === "failure"))).not.toContain("bare null");
    expect(events.find(e => e.kind === "model_response")?.payload).toMatchObject(raw);
  });
  it("distinguishes absent from unresolved, preventing uncertain values from reaching validation", () => {
    expect(
      validateExtraction(request, response("absent", null), docs).data,
    ).toEqual({ seller: null });
    expect(() =>
      validateExtraction(request, response("unresolved", null), docs),
    ).toThrow(expect.objectContaining({ code: "EXTRACTION_UNRESOLVED" }));
  });
  it("rejects foreign documents, impossible pages and unsupported normalized values", () => {
    for (const change of [
      (r: ReturnType<typeof response>) =>
        (r.fields[0].evidence[0].artifact_id = randomUUID()),
      (r: ReturnType<typeof response>) => (r.fields[0].evidence[0].page = 3),
      (r: ReturnType<typeof response>) =>
        (r.fields[0].normalized_value = "Other company"),
    ]) {
      const r = response();
      change(r);
      expect(() => validateExtraction(request, r, docs)).toThrow();
    }
  });
  it("requires coverage for every array record including null fields", () => {
    const req = {
      ...request,
      output_schema: { type: "object" },
      critical_paths: [["items", "*", "seller"]],
    };
    expect(() =>
      validateExtraction(
        req,
        {
          data: { items: [{ seller: null }, { seller: "Example Ltd" }] },
          fields: [{ ...response().fields[0], path: ["items", "1", "seller"] }],
        },
        docs,
      ),
    ).toThrow(/evidence/i);
  });
  it("blocks malformed data before generated postprocessing and preserves raw response in audit", async () => {
    let calls = 0;
    const events: string[] = [];
    await expect(
      invokeApprovedStep(
        {} as Project,
        randomUUID(),
        "agent",
        {},
        {
          invoke: async () => {
            calls++;
            return request;
          },
          reason: async () => ({}),
          extract: async () => response("unresolved", null),
        },
        AbortSignal.timeout(1000),
        async () => [
          {
            artifact_id: artifact,
            name: "example.txt",
            media_type: "text/plain",
            bytes: Buffer.from("Seller: Example Ltd"),
          },
        ],
        async (kind) => {
          events.push(kind);
        },
      ),
    ).rejects.toMatchObject({ code: "EXTRACTION_UNRESOLVED" });
    expect(calls).toBe(1);
    expect(events).toContain("model_response");
    expect(events).toContain("failure");
  });
});

it("never invokes a provider for invalid schemas or a non-Agent method", async () => {
  for (const [method, req, code] of [
    ["code", request, "METHOD_VIOLATION"],
    ["agent", { ...request, output_schema: { ...request.output_schema, $async: true } }, "EXTRACTION_SCHEMA_INVALID"],
    [
      "agent",
      {
        ...request,
        output_schema: { $ref: "https://untrusted.invalid/schema" },
      },
      "EXTRACTION_SCHEMA_INVALID",
    ],
  ] as const) {
    let modelCalls = 0;
    await expect(
      invokeApprovedStep(
        {} as Project,
        randomUUID(),
        method,
        {},
        {
          invoke: async () => req,
          reason: async () => ({}),
          extract: async () => {
            modelCalls++;
            return response();
          },
        },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code });
    expect(modelCalls).toBe(0);
  }
});
it("a cancelled provider result cannot reach generated postprocessing", async () => {
  const controller = new AbortController();
  let calls = 0;
  await expect(
    invokeApprovedStep(
      {} as Project,
      randomUUID(),
      "agent",
      {},
      {
        invoke: async () => {
          calls++;
          return request;
        },
        reason: async () => ({}),
        extract: async () => {
          controller.abort();
          return response();
        },
      },
      controller.signal,
      async () => [
        {
          artifact_id: artifact,
          name: "a.txt",
          media_type: "text/plain",
          bytes: Buffer.from("Example Ltd"),
        },
      ],
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
it("computes actual PDF page bounds rather than accepting provider page claims", async () => {
  const { PDFDocument } = await import("pdf-lib");
  const { evidenceDocuments } = await import(
    "../src/server/runtime/extraction"
  );
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.addPage();
  const sources = await evidenceDocuments([
    {
      artifact_id: artifact,
      name: "synthetic.pdf",
      media_type: "application/pdf",
      bytes: Buffer.from(await pdf.save()),
    },
  ]);
  expect(sources).toEqual([{ artifact_id: artifact, page_count: 2 }]);
  const r = response();
  r.fields[0].evidence[0].page = 3;
  expect(() => validateExtraction(request, r, sources)).toThrow();
});
