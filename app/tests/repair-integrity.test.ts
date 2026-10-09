import { expect, it } from "vitest";
import { assertRepairEvidenceIntegrity } from "../src/domain/repair-integrity";

const evidence = { source: { lot: "LOT928374", order: "ORDER-2026-018" } };
const source = (text: string) => ({ "steps/reader.mjs": text });

it("rejects case-insensitive copies in runtime prompts and human handlers", () => {
  for (const file of ["steps/reader.mjs", "human/reviewer.mjs"]) {
    expect(() => assertRepairEvidenceIntegrity(
      { [file]: 'export const instructions = "Correct lot928374 when reading.";' }, {}, {}, evidence,
    )).toThrow(expect.objectContaining({ code: "REPAIR_EVIDENCE_LEAK" }));
  }
});

it("allows genuine frozen constants, existing code, and general repairs", () => {
  const patch = source('const rule = "ORDER-2026-018";');
  expect(() => assertRepairEvidenceIntegrity(patch, {}, { instructions: "Use ORDER-2026-018 as the configured account." }, evidence)).not.toThrow();
  expect(() => assertRepairEvidenceIntegrity(patch, patch, {}, evidence)).not.toThrow();
  expect(() => assertRepairEvidenceIntegrity(source('return { id: context.input.id, limit: 30 };'), {}, {}, evidence)).not.toThrow();
  expect(() => assertRepairEvidenceIntegrity(source('const example = "OTHER928374";'), {}, {}, evidence)).not.toThrow();
});

it("keeps diagnostic identifiers out of executable code without censoring the diagnosis", () => {
  const baseline = { "README.md": "Observed LOT928374 in a failure." };
  expect(() => assertRepairEvidenceIntegrity(source('const example = "LOT928374";'), baseline, {}, evidence)).toThrow();
  expect(() => assertRepairEvidenceIntegrity({ "README.md": "Observed LOT928374 in a failure." }, {}, {}, evidence)).not.toThrow();
});

it("does not mistake ordinary words and policy thresholds for distinctive identifiers", () => {
  expect(() => assertRepairEvidenceIntegrity(source('const manufacturer="Example Company"; const limit=30;'), {}, {}, { manufacturer:"Example Company", limit:30 })).not.toThrow();
});

it("allows diagnostic comments and JavaScript names without authorizing them as baseline data", () => {
  const comment = '// Investigate LOT928374 before changing the rule.\nexport const limit = 30;';
  expect(() => assertRepairEvidenceIntegrity(source(comment), {}, {}, evidence)).not.toThrow();
  expect(() => assertRepairEvidenceIntegrity(source('const LOT928374 = context.input.id;'), {}, {}, evidence)).not.toThrow();
  expect(() => assertRepairEvidenceIntegrity(source('const lot = "LOT928374";'), source(comment), {}, evidence)).toThrow(expect.objectContaining({ code: "REPAIR_EVIDENCE_LEAK" }));
});

it("recognizes complete identifiers and preserves significant interior punctuation", () => {
  for (const text of ["PREFIXLOT928374", "LOT928374SUFFIX", "éLOT928374", "_LOT928374", "ORDER2026018"]) {
    expect(() => assertRepairEvidenceIntegrity(source(`const value = ${JSON.stringify(text)};`), {}, {}, evidence)).not.toThrow();
  }
  for (const text of ["(lot928374).", "ORDER-2026-018", "Observe LOT928374."]) {
    expect(() => assertRepairEvidenceIntegrity(source(`const value = ${JSON.stringify(text)};`), {}, {}, evidence)).toThrow(expect.objectContaining({ code: "REPAIR_EVIDENCE_LEAK" }));
  }
});

it("checks runtime data, regexes and template text, including decoded string escapes", () => {
  for (const text of [
    'const data = { lot: "LOT928374" };',
    'const pattern = /LOT928374/i;',
    'const prompt = `Check LOT928374 against ${context.input.id}`;',
    'const prompt = "\\u004cOT928374";',
  ]) expect(() => assertRepairEvidenceIntegrity(source(text), {}, {}, evidence)).toThrow(expect.objectContaining({ code: "REPAIR_EVIDENCE_LEAK" }));
  // These are explicitly outside this direct-copy guard, not an assertion that
  // computed answers or numeric-only constants are safe.
  expect(() => assertRepairEvidenceIntegrity(source('const value = "LOT" + "928374";'), {}, {}, evidence)).not.toThrow();
});

it("permits equivalent frozen/baseline runtime constants but not invalid baseline exemptions", () => {
  const patch = source('const id = "LOT928374"; export const retry = 2;');
  expect(() => assertRepairEvidenceIntegrity(patch, source('const id = "lot928374";'), {}, evidence)).not.toThrow();
  expect(() => assertRepairEvidenceIntegrity(patch, {}, { instructions: "Use lot928374." }, evidence)).not.toThrow();
  expect(() => assertRepairEvidenceIntegrity(patch, source('const id = "LOT928374"; /* unfinished'), {}, evidence)).toThrow(expect.objectContaining({ code: "REPAIR_EVIDENCE_LEAK" }));
});

it("terminates cyclic and oversized evidence without silently clearing a partial scan", () => {
  const cyclic: Record<string, unknown> = { lot: "LOT928374" }; cyclic.self = cyclic;
  expect(() => assertRepairEvidenceIntegrity(source('const value = "LOT928374";'), {}, {}, cyclic)).toThrow(expect.objectContaining({ code: "REPAIR_EVIDENCE_LEAK" }));
  for (const value of [Array(100_001).fill(null), "x".repeat(16_000_001)]) {
    expect(() => assertRepairEvidenceIntegrity(source('const value = 1;'), {}, {}, value)).toThrow(expect.objectContaining({ code: "REPAIR_INTEGRITY_LIMIT" }));
  }
  expect(() => assertRepairEvidenceIntegrity(source(";".repeat(250_001)), {}, {}, evidence)).toThrow(expect.objectContaining({ code: "REPAIR_INTEGRITY_LIMIT" }));
});

it("reports a bounded module location without exposing private identifiers or parser excerpts", () => {
  try {
    assertRepairEvidenceIntegrity(source('\nconst value = "LOT928374";'), {}, {}, evidence);
    throw new Error("Expected copy rejection");
  } catch (error) {
    expect(error).toMatchObject({ code: "REPAIR_EVIDENCE_LEAK", details: { module_index: 1, line: 2, column: 15 } });
    expect(String(error)).not.toContain("LOT928374");
    expect(String(error).length).toBeLessThan(1000);
  }
  expect(() => assertRepairEvidenceIntegrity(source('const value = "LOT928374'), {}, {}, evidence)).toThrow(expect.objectContaining({ code: "REPAIR_INTEGRITY_UNCHECKABLE" }));
});


it("distinguishes String.raw spelling from cooked template text", () => {
  expect(() => assertRepairEvidenceIntegrity(source('const value = String.raw`\\uZZZZ LOT928374`;'), {}, {}, evidence)).toThrow(expect.objectContaining({ code: "REPAIR_EVIDENCE_LEAK" }));
  expect(() => assertRepairEvidenceIntegrity(source('const value = String.raw`\\u004cOT928374`;'), {}, {}, evidence)).not.toThrow();
  expect(() => assertRepairEvidenceIntegrity(source('const value = String.raw`LOT928374`;'), {}, {}, evidence)).toThrow(expect.objectContaining({ code: "REPAIR_EVIDENCE_LEAK" }));
  expect(() => assertRepairEvidenceIntegrity(source('const value = String.raw`${"LOT928374"}`;'), {}, {}, evidence)).toThrow(expect.objectContaining({ code: "REPAIR_EVIDENCE_LEAK" }));
});


it("distinguishes an incomplete host scan from a detected implementation copy", async () => {
  const { invocationFailure } = await import("../src/server/runtime/invoke-step");
  const { DomainError } = await import("../src/domain/errors");
  expect(invocationFailure(new DomainError(422, "REPAIR_INTEGRITY_LIMIT", "bounded scan"))).toMatchObject({ category: "infrastructure" });
  expect(invocationFailure(new DomainError(422, "REPAIR_EVIDENCE_LEAK", "copied value"))).toMatchObject({ category: "implementation" });
});

it("spends the bounded scan on changed runtime text before looking for unnecessary baseline exemptions", () => {
  const largeEvidence = { values: [...Array(85_000).fill(null), "LOT928374"] };
  const baseline = source("void 0;\n".repeat(6000));
  const patch = source("void 0;\n".repeat(3000));
  // The candidate introduces no observed identifier. Parsing a large baseline
  // cannot change that result and previously exhausted the shared value budget.
  expect(() => assertRepairEvidenceIntegrity(patch, baseline, {}, largeEvidence)).not.toThrow();
  // If an exemption is needed, exhausting that same scan must still fail closed.
  expect(() => assertRepairEvidenceIntegrity(
    source('const value = "LOT928374";\n' + "void 0;\n".repeat(3000)),
    baseline, {}, largeEvidence,
  )).toThrow(expect.objectContaining({ code: "REPAIR_INTEGRITY_LIMIT" }));
});
