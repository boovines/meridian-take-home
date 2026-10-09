import type { Board, CanvasNode, Connection } from "./canvas";
export interface StructuralIssue {
  code: string;
  message: string;
  node_id?: string;
  connection_id?: string;
  repair_steps?: { node_id: string; instruction: string }[];
}
export function validateGraph(board: Board): StructuralIssue[] {
  const issues: StructuralIssue[] = [];
  const nodes = new Map(board.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, Connection[]>(),
    incoming = new Map<string, Connection[]>();
  for (const c of board.connections) {
    if (!outgoing.has(c.source_node_id)) outgoing.set(c.source_node_id, []);
    outgoing.get(c.source_node_id)!.push(c);
    if (!incoming.has(c.target_node_id)) incoming.set(c.target_node_id, []);
    incoming.get(c.target_node_id)!.push(c);
  }
  const triggers = board.nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1)
    issues.push({
      code: "TRIGGER_COUNT",
      message: "Keep exactly one Trigger before handing off this process.",
    });
  if (!board.workflow.desired_outcome.trim())
    issues.push({
      code: "MISSING_GOAL",
      message: "Describe what this workflow should accomplish.",
    });
  if (!board.nodes.some((n) => n.type === "outcome"))
    issues.push({
      code: "MISSING_OUTCOME",
      message: "Add an Outcome so the process has an explicit result.",
    });
  for (const c of board.connections) {
    if (!nodes.has(c.source_node_id) || !nodes.has(c.target_node_id))
      issues.push({
        code: "INVALID_ENDPOINT",
        connection_id: c.id,
        message: "This connection needs an active block at both ends.",
      });
  }
  function reachable(start: string, stop?: string) {
    const seen = new Set<string>(),
      queue = [start];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (id !== stop)
        for (const c of outgoing.get(id) || []) queue.push(c.target_node_id);
    }
    return seen;
  }
  // Only suggest a block for a simple fan-out/fan-in. More complex graphs
  // need the owner's routing decision, not a guessed replacement.
  function sharedNextBlock(
    split: CanvasNode,
    edges: Connection[],
    currentMergeId?: string,
  ) {
    const nextSteps = edges.map(
      (edge) => outgoing.get(edge.target_node_id) || [],
    );
    const candidateId = nextSteps[0]?.[0]?.target_node_id;
    const candidate = candidateId ? nodes.get(candidateId) : undefined;
    return candidate &&
      edges.length >= 2 &&
      candidate.id !== split.id &&
      candidate.id !== currentMergeId &&
      !candidate.join_for_split_id &&
      candidate.split_mode !== "parallel" &&
      edges.every((edge) => {
        const head = nodes.get(edge.target_node_id);
        return (
          head &&
          head.id !== candidate.id &&
          head.type !== "outcome" &&
          !head.split_mode &&
          (!head.join_for_split_id || head.id === currentMergeId)
        );
      }) &&
      nextSteps.every(
        (next) => next.length === 1 && next[0].target_node_id === candidate.id,
      ) &&
      (incoming.get(candidate.id) || []).every((edge) =>
        edges.some((branch) => branch.target_node_id === edge.source_node_id),
      )
      ? candidate
      : null;
  }
  if (triggers.length === 1) {
    const reached = reachable(triggers[0].id);
    for (const n of board.nodes)
      if (!reached.has(n.id))
        issues.push({
          code: "DISCONNECTED",
          node_id: n.id,
          message: `Connect or remove “${n.title || n.type}”; it cannot be reached from the Trigger.`,
        });
  }
  for (const n of board.nodes) {
    const edges = outgoing.get(n.id) || [];
    if (n.type === "outcome" && edges.length)
      issues.push({
        code: "OUTCOME_HAS_PATHS",
        node_id: n.id,
        message:
          "An Outcome ends the process. Remove its outgoing connections or use a different block type.",
      });
    if (n.type !== "outcome" && !edges.length)
      issues.push({
        code: "DEAD_END",
        node_id: n.id,
        message: `Connect “${n.title || n.type}” to its next step or an Outcome.`,
      });
    if (edges.length > 1 && !n.split_mode)
      issues.push({
        code: "MISSING_SPLIT_MODE",
        node_id: n.id,
        message:
          "Choose whether this split follows one matching path or runs both paths.",
      });
    if (n.split_mode && edges.length < 2)
      issues.push({
        code: "INCOMPLETE_SPLIT",
        node_id: n.id,
        message:
          "A split needs at least two outgoing paths; otherwise clear its split setting.",
      });
    if (
      n.split_mode === "exclusive" &&
      edges.some((e) => !e.is_default && !e.condition_text.trim())
    )
      issues.push({
        code: "MISSING_CONDITION",
        node_id: n.id,
        message: "Label each conditional path, or mark one as Otherwise.",
      });
    if (n.split_mode === "parallel") {
      if (edges.some((e) => e.is_default || e.condition_text.trim()))
        issues.push({
          code: "CONDITIONAL_PARALLEL",
          node_id: n.id,
          message:
            "Both parallel paths run unconditionally. Use a one-path decision for conditions.",
        });
      const merges = board.nodes.filter((j) => j.join_for_split_id === n.id);
      if (merges.length !== 1) {
        const suggestedMerge =
          merges.length === 0 ? sharedNextBlock(n, edges) : null;
        const splitName = n.title || n.type;
        issues.push({
          code: "MISSING_MERGE",
          node_id: n.id,
          message:
            merges.length === 0
              ? `“${splitName}” runs both paths, but no block is set to wait for them.`
              : `${merges.map((merge) => `“${merge.title || merge.type}”`).join(", ")} are all set to wait for paths from “${splitName}”. Choose only one shared block; on the others, set “Wait for both paths from” to “No paired merge” and save.`,
          repair_steps: suggestedMerge
            ? [
                {
                  node_id: suggestedMerge.id,
                  instruction: `Both paths already connect to “${suggestedMerge.title || suggestedMerge.type}”. On that block, set “Wait for both paths from” to “${splitName}”, then save the block.`,
                },
              ]
            : merges.length === 0
              ? [
                  {
                    node_id: n.id,
                    instruction: `Choose the shared block where every path from “${splitName}” should meet. Connect the paths to it, then on that block set “Wait for both paths from” to “${splitName}” and save.`,
                  },
                ]
              : undefined,
        });
        continue;
      }
      const merge = merges[0];
      const canReachMerge = new Set<string>(),
        reverseQueue = [merge.id];
      while (reverseQueue.length) {
        const id = reverseQueue.pop()!;
        if (canReachMerge.has(id)) continue;
        canReachMerge.add(id);
        for (const edge of incoming.get(id) || [])
          reverseQueue.push(edge.source_node_id);
      }
      const branches = edges.map((e) => reachable(e.target_node_id, merge.id));
      const missedBranches = edges.filter((_, i) => !branches[i].has(merge.id));
      if (missedBranches.length) {
        const suggestedMerge = sharedNextBlock(n, edges, merge.id);
        const splitName = n.title || n.type;
        const mergeName = merge.title || merge.type;
        const missedNames = missedBranches
          .map((edge) => {
            const head = nodes.get(edge.target_node_id);
            return `“${head?.title || head?.type || "missing block"}”`;
          })
          .join(", ");
        issues.push({
          code: "MERGE_UNREACHABLE",
          node_id: merge.id,
          message: `“${mergeName}” is set to wait for both paths from “${splitName}”, but the path starting at ${missedNames} cannot reach it.`,
          repair_steps: suggestedMerge
            ? [
                {
                  node_id: merge.id,
                  instruction: `On “${mergeName}”, set “Wait for both paths from” to “No paired merge”, then save the block.`,
                },
                {
                  node_id: suggestedMerge.id,
                  instruction: `Both paths already connect to “${suggestedMerge.title || suggestedMerge.type}”. On that block, set “Wait for both paths from” to “${splitName}”, then save the block.`,
                },
              ]
            : [
                {
                  node_id: merge.id,
                  instruction: `If “${mergeName}” is where the paths should meet, connect every path from “${splitName}” to it before the process ends. Otherwise, set “Wait for both paths from” to “No paired merge” here and select “${splitName}” in that setting on the shared block. Save your changes.`,
                },
              ],
        });
        // Unreachable/dead-end/outcome warnings below would repeat this broken
        // pairing. Keep this blocker; recheck the rest after the owner repairs it.
        continue;
      }
      const visited = new Set<string>();
      for (const branch of branches)
        for (const id of branch) {
          if (id === merge.id) continue;
          const step = nodes.get(id);
          if (
            visited.has(id) ||
            step?.split_mode === "parallel" ||
            step?.join_for_split_id ||
            id === n.id
          ) {
            issues.push({
              code: "OVERLAPPING_PARALLEL",
              node_id: n.id,
              message:
                "Keep parallel paths separate until their paired merge; nested or overlapping parallel sections are outside this demo.",
            });
            break;
          }
          visited.add(id);
          if (step?.type === "outcome")
            issues.push({
              code: "EARLY_PARALLEL_OUTCOME",
              node_id: id,
              message: "Join the parallel paths before the process ends.",
            });
          if (!canReachMerge.has(id))
            issues.push({
              code: "PARALLEL_DEAD_END",
              node_id: id,
              message: "This parallel step cannot reach its paired merge.",
            });
        }
      // No unrelated path may enter the merge and impersonate a branch completion.
      for (const edge of incoming.get(merge.id) || [])
        if (edge.source_node_id !== n.id && !visited.has(edge.source_node_id))
          issues.push({
            code: "EXTERNAL_MERGE_ENTRY",
            connection_id: edge.id,
            message:
              "This path enters a merge from outside its paired parallel section.",
          });
    }
    if (
      n.join_for_split_id &&
      nodes.get(n.join_for_split_id)?.split_mode !== "parallel"
    )
      issues.push({
        code: "INVALID_MERGE",
        node_id: n.id,
        message: "Pair this merge with an active Run both paths split.",
      });
  }
  const unique = new Map(
    issues.map((i) => [`${i.code}:${i.node_id || i.connection_id || ""}`, i]),
  );
  return [...unique.values()];
}
