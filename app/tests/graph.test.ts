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
