import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { llamaExtract } from "../src/server/integrations/llama-extract";
import { extractWithReinspection } from "../src/server/runtime/extraction-provider";
import { extractionRequest } from "../src/domain/extraction";
const id = randomUUID();
const request = extractionRequest.parse({
  kind: "extract",
  instructions: "Read seller",
  data: {},
  document_ids: [id],
  output_schema: { type: "object" },
  critical_paths: [["seller"]],
});
const value = (status = "found", seller: string | null = "Example") => ({
  data: { seller, unchanged: 42 },
  fields: [
    {
      path: ["seller"],
      status,
      raw_value: seller,
      normalized_value: seller,
      explanation: status === "found" ? null : "Cannot distinguish the header",
      evidence: [{ artifact_id: id, page: 1, text: "Seller: Example" }],
    },
  ],
});
async function pdf() {
  const p = await PDFDocument.create();
  p.addPage();
  return [
    {
      artifact_id: id,
      name: "fixture.pdf",
      media_type: "application/pdf",
      bytes: Buffer.from(await p.save()),
    },
  ];
}
function fixtureFetch(fail = false) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  let polls = 0;
  const transport: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    calls.push({
      path: u.pathname,
      method: init?.method || "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (u.pathname === "/api/v1/beta/files")
      return Response.json({ id: "dfl-fixture" });
    if (u.pathname === "/api/v2/extract")
      return Response.json({ id: "ext-fixture" });
    if (u.pathname.endsWith("/cancel") || init?.method === "DELETE")
      return Response.json({});
    if (polls++ === 0) return new Response(null, { status: 503 });
    return Response.json(
      fail
        ? { status: "FAILED" }
        : {
            status: "COMPLETED",
            extract_result: value(),
            configuration: { version: "2.5-fixed" },
            usage: { credits: 25, extract_credits: 15, parse_credits: 10 },
            extract_metadata: { parse_job_id: "pjb-fixture" },
          },
    );
  };
  return { calls, transport };
}
it("pins configuration, disables response caching, preserves provenance, retries only polling and removes its upload", async () => {
  const { calls, transport } = fixtureFetch();
  const result = await llamaExtract(
    request,
    await pdf(),
    AbortSignal.timeout(3000),
    { fetch: transport, api_key: "fixture", project_id: "fixture", poll_ms: 1 },
  );
  expect(result.output).toEqual(value());
  expect(result.metadata).toMatchObject({
    job_id: "ext-fixture",
    parse_cache_reuse: "unknown",
    configuration: { version: "2.5-fixed" },
  });
  expect(calls.find((c) => c.path === "/api/v2/extract")?.body).toMatchObject({
    configuration: {
      version: "2.5",
      disable_cache: true,
      parse_tier: "agentic",
    },
  });
  expect(calls.filter((c) => c.path === "/api/v2/extract")).toHaveLength(1);
  const sent = calls.find(c => c.path === "/api/v2/extract")?.body as { configuration: { data_schema: Record<string, unknown> } };
  expect(sent.configuration.data_schema.$defs).toBeUndefined();
  expect(sent.configuration.data_schema).toMatchObject({ properties: { data: request.output_schema } });
  expect(calls.at(-1)).toMatchObject({
    method: "DELETE",
    path: "/api/v1/beta/files/dfl-fixture",
  });
});
it("keeps failed provider work an error and attempts cancellation/cleanup", async () => {
  const { calls, transport } = fixtureFetch(true);
  await expect(
    llamaExtract(request, await pdf(), AbortSignal.timeout(3000), {
      fetch: transport,
      api_key: "fixture",
      project_id: "fixture",
      poll_ms: 1,
    }),
  ).rejects.toMatchObject({ code: "EXTRACTION_PROVIDER_ERROR" });
  expect(calls.some((c) => c.path.endsWith("/cancel"))).toBe(true);
});
it("accepts opaque UUID identities from live-style file and job responses and cleans up", async () => {
  const fileId = randomUUID(), jobId = randomUUID();
  const { calls, transport } = fixtureFetch();
  const fetcher: typeof fetch = async (input, init) => {
    const response = await transport(input, init);
    const path = new URL(String(input)).pathname;
    if (path === "/api/v1/beta/files") return Response.json({ id: fileId });
    if (path === "/api/v2/extract") return Response.json({ id: jobId });
    return response;
  };
  const result = await llamaExtract(request, await pdf(), AbortSignal.timeout(3000), {
    fetch: fetcher, api_key: "fixture", project_id: "fixture", poll_ms: 1,
  });
  expect(result.metadata).toMatchObject({ file_id: fileId, job_id: jobId });
  expect(calls.find(c => c.path === "/api/v2/extract")?.body).toMatchObject({ file_input: fileId });
  expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: `/api/v1/beta/files/${fileId}` });
});
it.each(["../files/other", "id?project_id=other", "id#fragment", ""])("rejects unsafe provider identity %s before further requests", async id => {
  const calls: string[] = [];
  const transport: typeof fetch = async input => {
    calls.push(new URL(String(input)).pathname);
    return Response.json({ id });
  };
  await expect(llamaExtract(request, await pdf(), AbortSignal.timeout(3000), {
    fetch: transport, api_key: "fixture", project_id: "fixture", poll_ms: 1,
  })).rejects.toMatchObject({ code: "EXTRACTION_PROVIDER_ERROR" });
  expect(calls).toEqual(["/api/v1/beta/files"]);
});
it("rejects oversized instructions plus context before uploading instead of silently truncating", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error("Unexpected upload"); };
  await expect(llamaExtract({ ...request, data: { text: "x".repeat(10000) } }, await pdf(), AbortSignal.timeout(3000), {
    fetch: transport, api_key: "fixture", project_id: "fixture",
  })).rejects.toMatchObject({ code: "EXTRACTION_CONTEXT_TOO_LARGE" });
  expect(calls).toBe(0);
});
it("does not retry uncertain job creation, and cleans up after cancellation", async () => {
  const controller = new AbortController();
  const { calls, transport } = fixtureFetch();
  const fetcher: typeof fetch = async (input, init) => {
    const result = await transport(input, init);
    if (new URL(String(input)).pathname === "/api/v2/extract")
      controller.abort();
    return result;
  };
  await expect(
    llamaExtract(request, await pdf(), controller.signal, {
      fetch: fetcher,
      api_key: "fixture",
      project_id: "fixture",
    }),
  ).rejects.toThrow();
  expect(calls.filter((c) => c.path === "/api/v2/extract")).toHaveLength(1);
  expect(calls.some((c) => c.path.endsWith("/cancel"))).toBe(true);
  expect(calls.at(-1)?.method).toBe("DELETE");
});
it("one localized correction changes only the implicated field and preserves both responses", async () => {
  let calls = 0;
  const result = await extractWithReinspection(
    request,
    await pdf(),
    AbortSignal.timeout(3000),
    async (req, docs) => {
      calls++;
      if (calls === 1)
        return {
          output: value("unresolved", null),
          metadata: { provider: "fixture" },
        };
      expect(docs[0].source_page_numbers).toEqual([1]);
      expect(req.critical_paths).toEqual([["seller"]]);
      const v = value();
      v.data.unchanged = 999;
      return { output: v, metadata: { provider: "fixture" } };
    },
  );
  expect(calls).toBe(2);
  expect(result.output).toMatchObject({
    data: { seller: "Example", unchanged: 42 },
  });
  expect(result.metadata).toHaveProperty("first_response");
  expect(result.metadata).toHaveProperty("second_response");
});
it("does not re-inspect an unlocalizable omission or exceed three source pages", async () => {
  for (const output of [
    { data: { seller: null }, fields: [] },
    {
      data: { seller: null },
      fields: [
        {
          ...value("unresolved", null).fields[0],
          evidence: [1, 2, 3, 4].map((page) => ({
            artifact_id: id,
            page,
            text: "unclear",
          })),
        },
      ],
    },
  ]) {
    let calls = 0;
    const p = await PDFDocument.create();
    for (let i = 0; i < 4; i++) p.addPage();
    const result = await extractWithReinspection(
      request,
      [
        {
          artifact_id: id,
          name: "four.pdf",
          media_type: "application/pdf",
          bytes: Buffer.from(await p.save()),
        },
      ],
      AbortSignal.timeout(3000),
      async () => {
        calls++;
        return { output, metadata: {} };
      },
    );
    expect(calls).toBe(1);
    expect(result.metadata).toMatchObject({
      reinspection: { status: "not_attempted" },
    });
  }
});
