import type { Board } from "../../src/domain/canvas";
import type { ReviewerOutput } from "../../src/domain/review";
/** Explicit browser-test fixture. Never used for a live review. */
export function fixtureReview(
  board: Board,
  hasExistingFinding: boolean,
): ReviewerOutput {
  const task = board.nodes.find(
    (n) => n.type === "task" && n.instructions === "Check invoice",
  );
  if (!task || hasExistingFinding) return { findings: [] };
  return {
    findings: [
      {
        action: "new",
        existing_thread_id: null,
        previous_finding_id: null,
        category: "ambiguity",
        title: "Which invoice fields are required?",
        message: "Confirm the required fields before this step is implemented.",
        node_ids: [task.id],
        connection_ids: [],
        change_kind: "detail",
        proposal: {
          node_id: task.id,
          title: null,
          instructions: "Require HTS, ANDA, FDA, REG, and NDC on each good.",
        },
      },
    ],
  };
}

/** Deterministic transport fixture, not evidence of model rewrite quality. */
export function fixtureReplyRewrite(
  context: import("../../src/domain/review-reply").ReplyContext,
): import("../../src/domain/review-reply").ReplyRewrite {
  return {
    outcome: "updated",
    explanation: "Updated the referenced block instructions from your answer.",
    updates: context.targets.map((node) => ({
      node_id: node.id,
      instructions: `${node.instructions}\n${context.answer}`,
    })),
  };
}
