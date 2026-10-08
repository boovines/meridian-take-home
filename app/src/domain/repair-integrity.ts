import { DomainError } from "./errors";

// A conservative copy detector, not a proof against arbitrary memorization.
// Numeric thresholds, short codes and ordinary words need semantic evaluation.
function identifiers(value: unknown): Set<string> {
  const found = new Set<string>();
  const pending = [value];
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === "string") {
      for (const match of next.matchAll(
        /[A-Za-z0-9][A-Za-z0-9_.\/-]{6,}[A-Za-z0-9]/g,
      )) {
        const token = match[0];
        if (
          token.length <= 128 &&
          (token.match(/[A-Za-z]/g)?.length ?? 0) >= 3 &&
          (token.match(/[0-9]/g)?.length ?? 0) >= 3
        )
          found.add(token.toUpperCase());
      }
    } else if (next && typeof next === "object") {
      for (const child of Object.values(next)) pending.push(child);
    }
  }
  return found;
}

export function assertRepairEvidenceIntegrity(
  candidateFiles: Record<string, string>,
  baselineFiles: Record<string, string>,
  frozenDefinition: unknown,
  evidence: unknown,
): void {
  const observed = identifiers(evidence);
  // The frozen requirements may legitimately prescribe a product/standard ID.
  // Existing source is not newly copied by this patch; this is not a retroactive audit.
  const permitted = identifiers([
    frozenDefinition,
    Object.entries(baselineFiles)
      .filter(([file]) => file.endsWith(".mjs"))
      .map(([, source]) => source),
  ]);
  for (const [file, source] of Object.entries(candidateFiles)) {
    if (!file.endsWith(".mjs") || source === baselineFiles[file]) continue;
    if (
      [...identifiers(source)].some(
        (token) => observed.has(token) && !permitted.has(token),
      )
    )
      throw new DomainError(
        422,
        "REPAIR_EVIDENCE_LEAK",
        "Generated runtime source introduces a distinctive identifier from evaluation evidence that is absent from the frozen requirements and baseline. Inspect the retained patch; use general rules rather than case-specific examples. This copy check does not prove absence of other overfitting.",
      );
  }
}
