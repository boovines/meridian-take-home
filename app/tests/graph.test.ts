import { expect, it } from "vitest";
import { validateGraph } from "../src/domain/validate-graph";
import type { Board, CanvasNode, Connection } from "../src/domain/canvas";
function board(
  nodes: Partial<CanvasNode>[],
  edges: [string, string, string?][],
): Board {
  return {
    workflow: { desired_outcome: "Produce a report" } as Board["workflow"],
    nodes: nodes.map((n) => ({
      title: n.id,
      instructions: "",
      config: {},
      split_mode: null,
      join_for_split_id: null,
      ...n,
    })) as CanvasNode[],
    connections: edges.map(
      ([source_node_id, target_node_id, condition_text = ""], i) => ({
        id: String(i),
        source_node_id,
        target_node_id,
        condition_text,
        is_default: false,
      }),
    ) as Connection[],
  };
}
it("accepts an explicit exclusive return loop and identifies missing routing conditions", () => {
  const b = board(
    [
      { id: "start", type: "trigger" },
      { id: "check", type: "check", split_mode: "exclusive" },
      { id: "human", type: "human_handoff" },
      { id: "end", type: "outcome" },
    ],
    [
      ["start", "check"],
      ["check", "human", "Missing information"],
      ["human", "check"],
      ["check", "end", "Complete"],
    ],
  );
  expect(validateGraph(b)).toEqual([]);
  b.connections[1].condition_text = "";
  expect(validateGraph(b).some((i) => i.code === "MISSING_CONDITION")).toBe(
    true,
  );
});
it("accepts distinct parallel branches with an explicit paired merge", () => {
  const b = board(
    [
      { id: "start", type: "trigger", split_mode: "parallel" },
      { id: "a", type: "task" },
      { id: "b", type: "task" },
      { id: "join", type: "check", join_for_split_id: "start" },
      { id: "end", type: "outcome" },
    ],
    [
      ["start", "a"],
      ["start", "b"],
      ["a", "join"],
      ["b", "join"],
      ["join", "end"],
    ],
  );
  expect(validateGraph(b)).toEqual([]);
  b.connections.push({
    id: "overlap",
    source_node_id: "a",
    target_node_id: "b",
    condition_text: "",
    is_default: false,
  } as Connection);
  expect(validateGraph(b).some((i) => i.code === "OVERLAPPING_PARALLEL")).toBe(
    true,
  );
});
it("rejects branches that terminate before the paired merge", () => {
  const b = board(
    [
      { id: "start", type: "trigger", split_mode: "parallel" },
      { id: "a", type: "task" },
      { id: "b", type: "outcome" },
      { id: "join", type: "outcome", join_for_split_id: "start" },
    ],
    [
      ["start", "a"],
      ["start", "b"],
      ["a", "join"],
    ],
  );
  expect(validateGraph(b).map((i) => i.code)).toContain("MERGE_UNREACHABLE");
});

it("explains a misplaced parallel wait setting once and names both edits", () => {
  const b = board(
    [
      {
        id: "start",
        title: "Shipment email",
        type: "trigger",
        split_mode: "parallel",
      },
      { id: "invoices", title: "Read invoices", type: "information" },
      {
        id: "certificates",
        title: "Read certificates",
        type: "information",
        join_for_split_id: "start",
      },
      { id: "validate", title: "Validate goods and batches", type: "check" },
      { id: "report", title: "Preview report", type: "outcome" },
    ],
    [
      ["start", "invoices"],
      ["start", "certificates"],
      ["invoices", "validate"],
      ["certificates", "validate"],
      ["validate", "report"],
    ],
  );
  const issues = validateGraph(b);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({
    code: "MERGE_UNREACHABLE",
    node_id: "certificates",
  });
  expect(issues[0].message).toContain(
    "“Read certificates” is set to wait for both paths from “Shipment email”",
  );
  expect(issues[0].message).toContain("“Read invoices” cannot reach it");
  expect(issues[0].repair_steps?.map((step) => step.node_id)).toEqual([
    "certificates",
    "validate",
  ]);
  expect(issues[0].repair_steps?.[0].instruction).toContain(
    "“No paired merge”",
  );
  expect(issues[0].repair_steps?.[1].instruction).toContain(
    "“Wait for both paths from” to “Shipment email”",
  );

  b.nodes[2].join_for_split_id = null;
  expect(validateGraph(b)).toMatchObject([
    { code: "MISSING_MERGE", repair_steps: [{ node_id: "validate" }] },
  ]);
  b.nodes[3].join_for_split_id = "start";
  expect(validateGraph(b)).toEqual([]);
});

it("does not recommend a replacement merge when a branch has multiple next steps", () => {
  const b = board(
    [
      { id: "start", type: "trigger", split_mode: "parallel" },
      { id: "a", type: "check", split_mode: "exclusive" },
      { id: "b", type: "task", join_for_split_id: "start" },
      { id: "shared", type: "task" },
      { id: "end", type: "outcome" },
    ],
    [
      ["start", "a"],
      ["start", "b"],
      ["a", "shared", "Accepted"],
      ["a", "end", "Rejected"],
      ["b", "shared"],
      ["shared", "end"],
    ],
  );
  const issue = validateGraph(b).find((i) => i.code === "MERGE_UNREACHABLE")!;
  expect(issue.repair_steps).toHaveLength(1);
  expect(issue.repair_steps?.[0].instruction).toContain(
    "If “b” is where the paths should meet",
  );
  expect(issue.repair_steps?.[0].instruction).not.toContain(
    "Both paths already connect",
  );
});
