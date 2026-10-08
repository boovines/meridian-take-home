import type { Board } from "@/domain/canvas";
import type { DiscussionMessage, DiscussionThread } from "@/domain/review";
import {
  replyIncorporationEvent,
  replyProposalEvent,
  replyProposalDecisionEvent,
  proposalStatus,
} from "@/domain/review-reply";
import { InstructionDiff } from "./instruction-diff";
export function ReplyChanges({
  message,
  messages,
  board,
  thread,
  disabled,
  drafts,
  onDraft,
  onDecision,
}: {
  message: DiscussionMessage;
  messages: DiscussionMessage[];
  board: Board;
  thread: DiscussionThread;
  disabled: boolean;
  drafts: Record<string, string>;
  onDraft: (key: string, text: string) => void;
  onDecision: (
    decision: "accept" | "reject",
    proposalId: string,
    nodeId: string,
    instructions?: string,
  ) => void;
}) {
  const proposed = replyProposalEvent.safeParse(message.event_data);
  if (!proposed.success || !proposed.data.edits.length)
    return <ReplyEvidence event={message.event_data} board={board} />;
  return (
    <section className="reply-proposal" aria-label="Proposed block changes">
      <div className="proposal-heading">
        <strong>Proposed changes</strong>
      </div>
      <p className="field-help">
        Edit the wording, then accept or reject each block separately.
      </p>
      {proposed.data.edits.map((edit) => {
        const title =
          board.nodes.find((n) => n.id === edit.node_id)?.title ||
          "Referenced block";
        const status = proposalStatus(
          message,
          messages,
          board,
          thread,
          edit.node_id,
        );
        const pending = status === "pending" || status === "stale";
        const key = `${message.id}:${edit.node_id}`;
        const decision = messages
          .map((m) => replyProposalDecisionEvent.safeParse(m.event_data))
          .find(
            (d) =>
              d.success &&
              d.data.proposal_message_id === message.id &&
              d.data.node_id === edit.node_id,
          );
        const saved =
          decision?.success && decision.data.decision === "accept"
            ? decision.data.instructions
            : undefined;
        const text =
          saved ??
          (pending
            ? (drafts[key] ?? edit.after.instructions)
            : edit.after.instructions);
        return (
          <details key={edit.node_id} className="block-diff" open>
            <summary>
              {title}
              <span className="proposal-state">
                {status === "pending" ? "Awaiting your approval" : status}
              </span>
            </summary>
            <div className="block-proposal-editor">
              <div
                className={`proposal-edit-comparison${pending ? " editable" : ""}`}
              >
                {pending ? (
                  <label>
                    Proposed instructions
                    <textarea
                      aria-label={`Proposed instructions for ${title}`}
                      value={text}
                      onChange={(event) => onDraft(key, event.target.value)}
                      disabled={disabled}
                      maxLength={20000}
                      rows={Math.min(
                        14,
                        Math.max(5, Math.ceil(text.length / 75)),
                      )}
                    />
                  </label>
                ) : null}
                <section
                  className="proposal-diff-preview"
                  aria-label={`Changes from original for ${title}`}
                >
                  <strong>
                    {status === "accepted"
                      ? "Saved changes"
                      : "Changes from original"}
                  </strong>
                  <InstructionDiff
                    before={edit.before.instructions}
                    after={text}
                  />
                </section>
              </div>
              {saved !== undefined && saved !== edit.after.instructions && (
                <details className="proposal-original">
                  <summary>Original AI suggestion</summary>
                  <p>{edit.after.instructions}</p>
                </details>
              )}
              {pending ? (
                <>
                  {status === "stale" && (
                    <p className="field-help">
                      The board changed. Your wording is preserved; reply again
                      for a fresh proposal before accepting.
                    </p>
                  )}
                  <div className="proposal-actions">
                    <button
                      className="primary"
                      disabled={disabled || status === "stale" || !text.trim()}
                      onClick={() =>
                        onDecision(
                          "accept",
                          message.id,
                          edit.node_id,
                          text.trim(),
                        )
                      }
                    >
                      Accept changes
                    </button>
                    <button
                      disabled={disabled}
                      onClick={() =>
                        onDecision("reject", message.id, edit.node_id)
                      }
                    >
                      Reject changes
                    </button>
                  </div>
                </>
              ) : (
                <p className="field-help">
                  {status === "accepted"
                    ? "Your accepted wording was saved to this block."
                    : status === "rejected"
                      ? "This block was left unchanged."
                      : "This proposal is no longer available to apply."}
                </p>
              )}
            </div>
          </details>
        );
      })}
      <p className="field-help">
        Only accepted blocks change. These decisions do not resolve the finding.
      </p>
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
