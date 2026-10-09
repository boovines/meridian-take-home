import type { Board } from "./canvas";
// Compare executable context, not canvas positions/revision counters. Include
// transitive inputs and incident routing so a matching node ID isn't sufficient.
export function stepContext(board: Board, nodeId: string) {
  const relevant = new Set<string>();
  const visit = (id: string) => {
    if (relevant.has(id)) return;
    relevant.add(id);
    for (const edge of board.connections)
      if (edge.target_node_id === id) visit(edge.source_node_id);
  };
  visit(nodeId);
  return {
    desired_outcome: board.workflow.desired_outcome,
    nodes: board.nodes
      .filter((n) => relevant.has(n.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        instructions: n.instructions,
        config: n.config,
        config_version: n.config_version,
        split_mode: n.split_mode,
        join_for_split_id: n.join_for_split_id,
      })),
    connections: board.connections
      .filter(
        (e) => relevant.has(e.source_node_id) || relevant.has(e.target_node_id),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({
        id: e.id,
        source_node_id: e.source_node_id,
        target_node_id: e.target_node_id,
        condition_text: e.condition_text,
        is_default: e.is_default,
      })),
  };
}
