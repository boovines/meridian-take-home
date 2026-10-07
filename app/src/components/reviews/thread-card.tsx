"use client";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import {
  findingLabel,
  type DiscussionThread,
  type ReviewState,
} from "@/domain/review";
import type { Board } from "@/domain/canvas";
export function ThreadCard({
  thread,
  state,
  board,
  locked,
  onRefresh,
  onLocate,
}: {
  thread: DiscussionThread;
  state: ReviewState;
  board: Board;
  locked: boolean;
  onRefresh: () => Promise<void>;
  onLocate: (kind: "node" | "connection", id: string) => void;
}) {
  const [reply, setReply] = useState(""),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const messages = state.messages.filter((m) => m.thread_id === thread.id),
    anchors = state.anchors.filter((a) => a.thread_id === thread.id),
    proposal = thread.proposed_patch;
  const current = board.nodes.find((n) => n.id === thread.proposed_node_id),
    stale = !!proposal && current?.revision !== thread.proposed_node_revision;
  async function submit(
    action: "reply" | "resolve" | "reject" | "reopen" | "apply",
  ) {
    setBusy(true);
    setError("");
    try {
      const base = `/api/workflows/${board.workflow.id}/threads/${thread.id}`;
      if (action === "reply") {
        await api(`${base}/messages`, "POST", {
          body: reply,
          parent_message_id:
            messages.filter((m) => m.kind === "comment").at(-1)?.id || null,
          request_key: crypto.randomUUID(),
        });
        setReply("");
      } else {
        await api(`${base}/actions`, "POST", {
          action,
          reason,
          expected_revision: thread.revision,
          request_key: crypto.randomUUID(),
        });
        setReason("");
      }
      await onRefresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className={`review-thread ${thread.status}`}
      open={thread.status === "open"}
    >
      <summary>
        <span className="thread-status">
          {thread.kind === "note"
            ? "Note"
            : findingLabel(thread, state.messages)}
        </span>
        <strong>{thread.title}</strong>
      </summary>
      <div className="thread-content">
        {thread.previous_finding_id && (
          <p className="field-help">
            Revisits a previous finding after the process changed. The earlier
            decision remains in history.
          </p>
        )}
        <div className="anchor-links">
          {anchors.length ? (
            anchors.map((a) => {
              const n = board.nodes.find((n) => n.id === a.node_id),
                c = board.connections.find((c) => c.id === a.connection_id),
                present = !!n || !!c;
              return (
                <button
                  key={a.id}
                  className="subtle"
                  disabled={!present}
                  onClick={() =>
                    onLocate(
                      a.node_id ? "node" : "connection",
                      (a.node_id || a.connection_id)!,
                    )
                  }
                >
                  {n?.title ||
                    (c
                      ? "View connection"
                      : `${String(a.context_snapshot.title || "Referenced item")} · removed`)}
                </button>
              );
            })
          ) : (
            <span className="field-help">Entire workflow</span>
          )}
        </div>
        {messages.map((m) => (
          <div key={m.id} className={`thread-message ${m.kind}`}>
            <small>
              {m.author_kind === "ai"
                ? "AI review"
                : m.author_kind === "customer"
                  ? "Process owner"
                  : "Activity"}
            </small>
            <p>{m.body}</p>
          </div>
        ))}
        {thread.status === "open" && proposal && (
          <div className="proposal">
            <strong>Suggested block details</strong>
            {Object.entries(proposal).map(([field, value]) => (
              <div key={field}>
                <small>{field}</small>
                <p className="proposal-before">
                  {current?.[field as "title" | "instructions"] || "(empty)"}
                </p>
                <p>{value}</p>
              </div>
            ))}
            {stale ? (
              <p className="inline-error">
                This block changed after the suggestion. Compare the text and
                edit it manually, or request another review.
              </p>
            ) : (
              <button
                disabled={locked || busy}
                onClick={() => void submit("apply")}
              >
                Apply and resolve
              </button>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {thread.status === "open" && !locked && (
          <>
            <label>
              Your answer or comment
              <textarea
                aria-label={`Reply to ${thread.title}`}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={2}
                maxLength={20000}
              />
            </label>
            <button
              disabled={busy || !reply.trim()}
              onClick={() => void submit("reply")}
            >
              Add reply
            </button>
            {thread.kind === "finding" && (
              <div className="finding-resolution">
                <label>
                  Reason for closing
                  <textarea
                    aria-label={`Resolution reason for ${thread.title}`}
                    placeholder="What changed, or why is no change needed?"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    maxLength={10000}
                  />
                </label>
                <div className="button-row">
                  <button
                    disabled={busy || !reason.trim()}
                    onClick={() => void submit("resolve")}
                  >
                    Resolve
                  </button>
                  <button
                    disabled={busy || !reason.trim()}
                    onClick={() => void submit("reject")}
                  >
                    Reject suggestion
                  </button>
                </div>
                <p className="field-help">
                  For a new step or branch, edit the canvas yourself before
                  resolving. Your explanation records your decision.
                </p>
              </div>
            )}
          </>
        )}
        {thread.status === "closed" && thread.kind === "finding" && !locked && (
          <button
            className="subtle"
            disabled={busy}
            onClick={() => void submit("reopen")}
          >
            Reopen finding
          </button>
        )}
      </div>
    </details>
  );
}
