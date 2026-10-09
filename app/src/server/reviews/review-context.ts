import { DomainError } from "../../domain/errors";

export const REVIEW_CONTEXT_LIMIT = 180_000;
export const REVIEW_CONTEXT_TOO_LARGE_MESSAGE =
  "Review input is too large, even after removing duplicate text. Your changes are saved. An engineer needs to reduce the review context before retrying.";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Lossless prompt projection: stored history and customer wording remain unchanged. */
export function serializeReviewContext(context: unknown): string {
  const original = JSON.stringify(context);
  if (Buffer.byteLength(original) <= REVIEW_CONTEXT_LIMIT) return original;

  const value: Json = JSON.parse(original);
  const occurrences = new Map<string, number>();
  const keys = new Set<string>();
  function visit(item: Json) {
    if (typeof item === "string" && item.length >= 256)
      occurrences.set(item, (occurrences.get(item) ?? 0) + 1);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object")
      for (const [key, child] of Object.entries(item)) {
        keys.add(key);
        visit(child);
      }
  }
  visit(value);
  // Avoid interpreting an existing customer config object as one of our references.
  let referenceKey = "$review_text";
  while (keys.has(referenceKey)) referenceKey += "_";
  const ids = new Map(
    [...occurrences]
      .filter(([, count]) => count > 1)
      .map(([text], index) => [text, `text_${index + 1}`]),
  );
  function encode(item: Json): Json {
    if (typeof item === "string" && ids.has(item))
      return { [referenceKey]: ids.get(item)! };
    if (Array.isArray(item)) return item.map(encode);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [key, encode(child)]),
      );
    return item;
  }
  const prompt = JSON.stringify({
    text_reference_key: referenceKey,
    texts: Object.fromEntries([...ids].map(([text, id]) => [id, text])),
    context: encode(value),
  });
  if (Buffer.byteLength(prompt) > REVIEW_CONTEXT_LIMIT)
    throw new DomainError(
      413,
      "REVIEW_CONTEXT_TOO_LARGE",
      REVIEW_CONTEXT_TOO_LARGE_MESSAGE,
    );
  return prompt;
}
