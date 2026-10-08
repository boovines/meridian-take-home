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
