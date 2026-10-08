"use client";
import { useState } from "react";
import { ErrorNotice } from "../error-notice";
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
    [responseType, setResponseType] = useState<"reply" | "resolve" | "reject">(
      "reply",
    ),
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
          reason: action === "reopen" ? "" : reply,
          expected_revision: thread.revision,
          request_key: crypto.randomUUID(),
        });
        setReply("");
        setResponseType("reply");
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
        <span
          className={`thread-status ${findingLabel(thread, state.messages).toLowerCase()}`}
        >
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
          <ErrorNotice title="Couldn’t save this change" message={error} />
        )}
        {thread.status === "open" && !locked && (
          <form
            className="response-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(responseType);
            }}
          >
            <label>
              Your response
              <textarea
                aria-label={`Response to ${thread.title}`}
                value={reply}
                onChange={(event) => setReply(event.target.value)}
                placeholder={
                  responseType === "reply"
                    ? "Add context or answer the question…"
                    : responseType === "resolve"
                      ? "What changed, or why is no change needed?"
                      : "Why doesn't this suggestion apply?"
                }
                rows={3}
                required
                disabled={busy}
                maxLength={responseType === "reply" ? 20000 : 10000}
              />
            </label>
            <div className="response-actions">
              <label>
                Response type
                <select
                  aria-label={`Response type for ${thread.title}`}
                  value={responseType}
                  disabled={busy}
                  onChange={(event) =>
                    setResponseType(event.target.value as typeof responseType)
                  }
                >
                  <option value="reply">Reply</option>
                  {thread.kind === "finding" && (
                    <>
                      <option value="resolve">Resolve</option>
                      <option value="reject">Reject</option>
                    </>
                  )}
                </select>
              </label>
              <button className="primary" disabled={busy || !reply.trim()}>
                {busy
                  ? "Sending…"
                  : responseType === "reply"
                    ? "Send reply"
                    : responseType === "resolve"
                      ? "Resolve finding"
                      : "Reject suggestion"}
              </button>
            </div>
            <p className="field-help">
              {thread.kind === "note"
                ? "Add context to this discussion. Notes do not block handoff."
                : responseType === "reply"
                  ? "A reply marks this as answered. Resolve or reject it when you've made a decision."
                  : responseType === "resolve"
                    ? "Update the block or paths first if needed. Your response records how this was resolved."
                    : "Your response records why you're keeping the process as it is."}
            </p>
          </form>
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
