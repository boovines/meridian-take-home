import type { Board } from "../../src/domain/canvas";
import type { PlanStep } from "../../src/domain/engineering";
export function fixtureSources(board: Board, steps: PlanStep[]) {
  return {
    status: "ready" as const,
    explanation:
      "Sanitized fixture project for browser verification; no live model was called.",
    steps: steps.map((s) => ({
      node_id: s.node_id,
      source_lines: [
        `export async function run(context) { return {kind:'complete',output:context.input,matching_connection_ids:${JSON.stringify(board.connections.filter((e) => e.source_node_id === s.node_id && !e.is_default).map((e) => e.id))}}; }`,
      ],
    })),
  };
}
