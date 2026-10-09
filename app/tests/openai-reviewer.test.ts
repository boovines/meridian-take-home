import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { generateText, Output } from "ai";
import { z } from "zod";
import { reviewWithOpenAI } from "../src/server/integrations/openai-reviewer";
import type { DiscussionThread } from "../src/domain/review";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: { object: vi.fn(() => ({})) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateText).mockResolvedValue({ output: { findings: [] } } as never);
});

async function outputSchema(threads: Pick<DiscussionThread, "id" | "kind" | "status">[]) {
  await reviewWithOpenAI({
    run: { model: "fixture" },
    board: { workflow: { desired_outcome: "Approve a purchase" }, nodes: [], connections: [] },
    discussion: { threads, anchors: [], messages: [] },
  } as unknown as Parameters<typeof reviewWithOpenAI>[0], AbortSignal.timeout(1000));
  return vi.mocked(Output.object).mock.calls[0][0].schema as z.ZodType;
}

function finding(id: string | null, action = "followup", previous: string | null = null) {
  return { findings: [{
    action, existing_thread_id: id, previous_finding_id: previous,
    category: "ambiguity", title: "Clarify approval", message: "Who approves?",
    node_ids: [], connection_ids: [], change_kind: "question", proposal: null,
  }] };
}

it("prevents the provider from following up on a customer note when there are no AI findings", async () => {
  const note = randomUUID();
  const schema = await outputSchema([{ id: note, kind: "note", status: "open" }]);
  expect(schema.safeParse(finding(note)).success).toBe(false);
  expect(schema.safeParse(finding(null)).success).toBe(false);
  expect(schema.safeParse(finding(null, "new")).success).toBe(true);
  expect(schema.safeParse({ findings: [] }).success).toBe(true);
});

it("limits follow-ups to open findings and linked concerns to closed findings", async () => {
  const open = randomUUID(), closed = randomUUID(), note = randomUUID();
  const schema = await outputSchema([
    { id: open, kind: "finding", status: "open" },
    { id: closed, kind: "finding", status: "closed" },
    { id: note, kind: "note", status: "closed" },
  ]);
  expect(schema.safeParse(finding(open)).success).toBe(true);
  for (const id of [closed, note, randomUUID(), null])
    expect(schema.safeParse(finding(id)).success).toBe(false);
  expect(schema.safeParse(finding(null, "new", closed)).success).toBe(true);
  for (const id of [open, note, randomUUID()])
    expect(schema.safeParse(finding(null, "new", id)).success).toBe(false);
  expect(schema.safeParse(finding(open, "new")).success).toBe(false);
  expect(schema.safeParse(finding(open, "followup", closed)).success).toBe(false);
  // OpenAI rejects oneOf even though it is valid JSON Schema. Open findings
  // must use supported anyOf branches without widening eligible references.
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  expect(jsonSchema).not.toContain('"oneOf"');
  expect(jsonSchema).toContain('"anyOf"');
});

it("reviews long acceptance histories without duplicating identical instruction snapshots", async () => {
  const instructions = "Verify every required field and preserve the source evidence. ".repeat(230);
  const input = {
    run: { model: "fixture" },
    board: { workflow: { desired_outcome: "Review requests" }, nodes: [{ id: randomUUID(), instructions }], connections: [] },
    discussion: { threads: [{ id: "thread", kind: "note", status: "closed", resolution_note: "Approved these instructions." }], anchors: [],
      messages: Array.from({ length: 8 }, (_, i) => ({ id: `message-${i}`, thread_id: "thread", author_kind: "customer", body: "Keep the source evidence.", event_data: { action: "reply_proposal_decided", decision: "accept", before: { instructions }, after: { instructions }, instructions } })),
    },
  } as unknown as Parameters<typeof reviewWithOpenAI>[0];
  const unchanged = structuredClone(input);
  await reviewWithOpenAI(input, AbortSignal.timeout(1000));
  expect(generateText).toHaveBeenCalledOnce();
  const prompt = String(vi.mocked(generateText).mock.calls[0][0].prompt);
  expect(Buffer.byteLength(prompt)).toBeLessThan(180000);
  expect(input).toEqual(unchanged);
  expect(prompt).toContain("Keep the source evidence.");
  expect(prompt).toContain("Approved these instructions.");
});
