import { expect, it } from "vitest";
import {
  serializeReviewContext,
  REVIEW_CONTEXT_TOO_LARGE_MESSAGE,
} from "../src/server/reviews/review-context";

it("round-trips long history exactly, including customer text that resembles a reference", () => {
  const instructions = "Check source evidence. ".repeat(1000);
  const context = {
    nodes: [{ instructions, config: { $review_text: "text_1" } }],
    messages: Array.from({ length: 12 }, (_, i) => ({
      body: `Customer explanation ${i}`,
      event: {
        before: { instructions },
        after: { instructions },
        decision: i % 2 ? "accept" : "reject",
      },
    })),
  };
  const original = structuredClone(context);
  const encoded = JSON.parse(serializeReviewContext(context));
  function expand(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 1 && entries[0][0] === encoded.text_reference_key)
        return encoded.texts[entries[0][1] as string];
      return Object.fromEntries(
        entries.map(([key, child]) => [key, expand(child)]),
      );
    }
    return value;
  }
  expect(encoded.text_reference_key).not.toBe("$review_text");
  expect(expand(encoded.context)).toEqual(original);
  expect(context).toEqual(original);
  expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(180000);
});

it("keeps small contexts plain and fails oversized unique text with an actionable error", () => {
  expect(serializeReviewContext({ goal: "Approve requests" })).toBe(
    JSON.stringify({ goal: "Approve requests" }),
  );
  expect(() =>
    serializeReviewContext({ instructions: "é".repeat(100000) }),
  ).toThrow(
    expect.objectContaining({
      code: "REVIEW_CONTEXT_TOO_LARGE",
      message: REVIEW_CONTEXT_TOO_LARGE_MESSAGE,
    }),
  );
});
