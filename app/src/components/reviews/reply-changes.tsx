import type { Board } from "@/domain/canvas";
import type { DiscussionMessage, DiscussionThread } from "@/domain/review";
import {
  replyIncorporationEvent,
  replyProposalEvent,
  proposalStatus,
} from "@/domain/review-reply";
import { InstructionDiff } from "./instruction-diff";
export function ReplyChanges({
  message,
  messages,
  board,
  thread,
  disabled,
  onDecision,
}: {
  message: DiscussionMessage;
  messages: DiscussionMessage[];
  board: Board;
  thread: DiscussionThread;
  disabled: boolean;
  onDecision: (decision: "accept" | "reject", proposalId: string) => void;
}) {
  const proposed = replyProposalEvent.safeParse(message.event_data);
  if (!proposed.success || !proposed.data.edits.length)
    return <ReplyEvidence event={message.event_data} board={board} />;
  const status = proposalStatus(message, messages, board, thread);
  return (
    <section className="reply-proposal" aria-label="Proposed block changes">
      <div className="proposal-heading">
        <strong>Proposed changes</strong>
        <span className="proposal-state">
          {status === "pending" ? "Awaiting your approval" : status}
        </span>
      </div>
      {proposed.data.edits.map((edit) => (
        <details key={edit.node_id} className="block-diff" open>
          <summary>
            {board.nodes.find((n) => n.id === edit.node_id)?.title ||
              "Referenced block"}
          </summary>
          <InstructionDiff
            before={edit.before.instructions}
            after={edit.after.instructions}
          />
        </details>
      ))}
      {status === "pending" || status === "stale" ? (
        <>
          {status === "stale" && (
            <p className="field-help">
              The board changed. Reply again for a fresh proposal before
              accepting.
            </p>
          )}
          <div className="proposal-actions">
            <button
              className="primary"
              disabled={disabled || status === "stale"}
              onClick={() => onDecision("accept", message.id)}
            >
              Accept changes
            </button>
            <button
              disabled={disabled}
              onClick={() => onDecision("reject", message.id)}
            >
              Reject changes
            </button>
          </div>
          <p className="field-help">
            Blocks change only when you accept. This does not resolve the
            finding.
          </p>
        </>
      ) : (
        <p className="field-help">
          {status === "accepted"
            ? "These instructions were saved to the blocks."
            : status === "rejected"
              ? "You rejected this proposal. No blocks were changed."
              : "This proposal is no longer available to apply."}
        </p>
      )}
    </section>
  );
}

function ReplyEvidence({
  event,
  board,
}: {
  event: Record<string, unknown> | null;
  board: Board;
}) {
  const parsed = replyIncorporationEvent.safeParse(event);
  if (!parsed.success || !parsed.data.applied.length) return null;
  return (
    <details className="thread-references">
      <summary>View saved block changes ({parsed.data.applied.length})</summary>
      {parsed.data.applied.map((edit) => (
        <div key={edit.node_id} className="proposal">
          <strong>
            {board.nodes.find((n) => n.id === edit.node_id)?.title ||
              "Referenced block"}
          </strong>
          <small>Before</small>
          <p className="proposal-before">
            {edit.before.instructions || "(empty)"}
          </p>
          <small>Saved instructions</small>
          <p>{edit.after.instructions}</p>
        </div>
      ))}
    </details>
  );
}
