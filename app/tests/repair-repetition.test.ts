import { expect, it } from "vitest";
import { repetitionDifferences } from "../src/server/repairs/repetition";

const trace = (output_data: unknown, node_visit_number = 1, occurrence_id = "visit") => ({
  case_id: "case", node_id: "node", node_visit_number, occurrence_id, status: "completed", output_data,
});

it("compares the same visit and case without conflating missing fields with null", () => {
  const current = [trace({ nullable: null }, 1, "current"), trace({ value: 3 }, 2)];
  const earlier = [trace({}, 1, "prior"), trace({ value: 2 }, 2), { ...trace({value:9}), case_id:"other" }];
  const result = repetitionDifferences(current, earlier);
  expect(result.compared_occurrences).toBe(2);
  expect(result.unpaired_or_ambiguous_occurrences).toBe(1);
  expect(result.changes[0]).toMatchObject({
    path:["nullable"], earlier:{present:false}, current:{present:true,value:null},
    earlier_occurrence_id:"prior", current_occurrence_id:"current",
  });
  expect(result.changes[1]).toMatchObject({node_visit_number:2,path:["value"],earlier:{value:2},current:{value:3}});
});

it("does not arbitrarily pair duplicate visits, incomplete steps or unrelated cases", () => {
  expect(repetitionDifferences([trace(1),trace(2)],[trace(3)])).toMatchObject({compared_occurrences:0,changes:[]});
  expect(repetitionDifferences([trace(1)],[trace(2),trace(3)])).toMatchObject({compared_occurrences:0,changes:[]});
  expect(repetitionDifferences([{...trace(1),status:"failed"}],[trace(3)])).toMatchObject({compared_occurrences:0,changes:[]});
});

it("marks omitted changes and bounded values without calling an earlier output correct", () => {
  const result = repetitionDifferences([trace(Array(120).fill("b"))],[trace(Array(120).fill("a"))]);
  expect(result.changes.length).toBeLessThanOrEqual(64);
  expect(result.changes.length + result.omitted_changes).toBe(120);
  expect(result.traversal_limited).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(result.changes))).toBeLessThan(16200);
  const large = repetitionDifferences([trace({text:"b".repeat(2000)})],[trace({text:"a".repeat(2000)})]);
  expect(large.changes[0].current).toMatchObject({present:true,truncated:true,original_bytes:2002});
  expect(large.alignment).toContain("not expected answers");
});

it("stops excessively broad traversal and exposes that limitation", () => {
  const result = repetitionDifferences([trace(Array(50001).fill(1))],[trace(Array(50001).fill(2))]);
  expect(result.traversal_limited).toBe(true);
  expect(result.changes).toHaveLength(0);
});

it("ignores JSON key order and preserves index changes without assuming record identity", () => {
  expect(repetitionDifferences([trace({b:2,a:1})],[trace({a:1,b:2})]).changes).toHaveLength(0);
  const result = repetitionDifferences([trace([2,1])],[trace([1,2])]);
  expect(result.changes.map(c=>c.path)).toEqual([[0],[1]]);
  expect(result.alignment).toContain("arrays by index");
});

it("reports unmatched occurrences on both sides, including a current-only visit", () => {
  const result = repetitionDifferences([trace(1), trace(2, 2)], [trace(1), trace(3, 3)]);
  expect(result).toMatchObject({
    completed_comparisons: 1, unpaired_or_ambiguous_occurrences: 2,
    unpaired_current_occurrences: 1, unpaired_earlier_occurrences: 1,
  });
});

it("bounds deep and cyclic outputs and reports unvisited pairs separately", () => {
  const deep = (leaf: unknown) => {
    let value = leaf;
    for (let i = 0; i < 100; i++) value = { nested: value };
    return value;
  };
  const result = repetitionDifferences([trace(deep(1)), trace(1, 2)], [trace(deep(2)), trace(2, 2)]);
  expect(result).toMatchObject({
    traversal_limited: true, completed_comparisons: 0,
    compared_occurrences: 1, unvisited_paired_occurrences: 1,
  });
  const a: Record<string, unknown> = {}, b: Record<string, unknown> = {};
  a.self = a; b.self = b;
  expect(repetitionDifferences([trace(a)], [trace(b)]).traversal_limited).toBe(true);
});

it("does not serialize a structured addition and caps long scalar previews", () => {
  const added = { toJSON() { throw new Error("must not serialize an unbounded subtree"); } };
  const result = repetitionDifferences([trace({ added, text: "🙂".repeat(100000) })], [trace({})]);
  expect(result.changes[0]).toMatchObject({
    path: ["added"], current: { present: true, truncated: true, preview_omitted: "structured_value" },
  });
  expect(result.changes[1].current).toMatchObject({ present: true, truncated: true, original_code_units: 200000 });
  expect(Buffer.byteLength(JSON.stringify(result.changes))).toBeLessThanOrEqual(16000);
});

it("bounds wide object enumeration and oversized keys before building paths", () => {
  const wide = Object.fromEntries(Array.from({length: 50001}, (_, i) => [`k${i}`, i]));
  expect(repetitionDifferences([trace(wide)], [trace({})]).traversal_limited).toBe(true);
  expect(repetitionDifferences([trace({ ["x".repeat(1000001)]: 1 })], [trace({})]).traversal_limited).toBe(true);
});
