import { it, expect } from "vitest";
import { invokeApprovedStep } from "../src/server/runtime/invoke-step";
import { DomainError } from "../src/domain/errors";
import type { Project } from "../src/domain/project";

it("records selected source, model input and raw response before generated postprocessing fails", async () => {
  const events: { kind: string; payload: unknown }[] = [];
  let calls = 0;
  const request = {
    kind: "reason",
    instructions: "Read the delivery date",
    data: { format: "ISO" },
    document_ids: ["11111111-1111-4111-8111-111111111111"],
  };
  await expect(
    invokeApprovedStep(
      {} as Project,
      "node",
      "agent",
      {},
      {
        model: { provider: "fixture", name: "fixture-model" },
        invoke: async () => {
          if (calls++ === 0) return request;
          throw new DomainError(422, "STEP_CRASH", "Postprocessing failed");
        },
        reason: async () => ({ delivery_date: "2026-10-09" }),
      },
      AbortSignal.timeout(10000),
      async () => [
        {
          artifact_id: "11111111-1111-4111-8111-111111111111",
          name: "schedule.txt",
          media_type: "text/plain",
          bytes: Buffer.from("October 9, 2026"),
        },
      ],
      async (kind, payload) => {
        events.push({ kind, payload });
      },
    ),
  ).rejects.toMatchObject({ code: "STEP_CRASH" });
  expect(events.map((e) => e.kind)).toEqual([
    "initial_output",
    "model_request",
    "model_response",
    "failure",
  ]);
  expect(events[1].payload).toMatchObject({
    instructions: request.instructions,
    data: request.data,
    model: { name: "fixture-model" },
    documents: [
      {
        artifact_id: "11111111-1111-4111-8111-111111111111",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ],
  });
  expect(events[2].payload).toEqual({ delivery_date: "2026-10-09" });
});

it("retains invalid document selection and sanitized failure without calling the model", async () => {
  const events: { kind: string; payload: unknown }[] = [];
  await expect(
    invokeApprovedStep(
      {} as Project,
      "node",
      "agent",
      {},
      {
        invoke: async () => ({
          kind: "reason",
          instructions: "Read it",
          data: {},
          document_ids: ["22222222-2222-4222-8222-222222222222"],
        }),
        reason: async () => {
          throw Error("Model must not be called");
        },
      },
      AbortSignal.timeout(10000),
      async () => {
        throw new DomainError(422, "DOCUMENT_ACCESS_DENIED", "Denied");
      },
      async (kind, payload) => {
        events.push({ kind, payload });
      },
    ),
  ).rejects.toMatchObject({ code: "DOCUMENT_ACCESS_DENIED" });
  expect(events.map((e) => e.kind)).toEqual(["initial_output", "failure"]);
  expect(events[0].payload).toMatchObject({
    document_ids: ["22222222-2222-4222-8222-222222222222"],
  });
});
