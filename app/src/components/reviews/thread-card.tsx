"use client";
import { useRef, useState } from "react";
import { ErrorNotice } from "../error-notice";
import { api, ApiError, errorMessage } from "@/lib/api";
import {
  findingLabel,
  type DiscussionThread,
  type ReviewState,
} from "@/domain/review";
import { replyIncorporationEvent } from "@/domain/review-reply";
import type { Board } from "@/domain/canvas";
export function ThreadCard({
  thread,
  state,
  board,
  locked,
  onRefresh,
  onLocate,
  onHover,
  onFocusThread,
}: {
  thread: DiscussionThread;
  state: ReviewState;
  board: Board;
  locked: boolean;
  onRefresh: () => Promise<void>;
  onHover: (threadId: string | null) => void;
  onFocusThread: (threadId: string | null) => void;
  onLocate: (kind: "node" | "connection", id: string) => void;
}) {
  const [reply, setReply] = useState(""),
    [responseType, setResponseType] = useState<"reply" | "resolve" | "reject">(
      "reply",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [refreshFailed, setRefreshFailed] = useState(false);
  const pendingRequest = useRef<{ signature: string; key: string } | null>(
    null,
  );
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
    setRefreshFailed(false);
    try {
      const signature = JSON.stringify({
        action,
        reply,
        revision: thread.revision,
      });
      if (pendingRequest.current?.signature !== signature)
        pendingRequest.current = { signature, key: crypto.randomUUID() };
      const requestKey = pendingRequest.current.key;
      const base = `/api/workflows/${board.workflow.id}/threads/${thread.id}`;
      if (action === "reply") {
        await api(`${base}/messages`, "POST", {
          body: reply,
          expected_revision: thread.revision,
          parent_message_id:
            messages.filter((m) => m.kind === "comment").at(-1)?.id || null,
          request_key: requestKey,
        });
        setReply("");
      } else {
        await api(`${base}/actions`, "POST", {
          action,
          reason: action === "reopen" ? "" : reply,
          expected_revision: thread.revision,
          request_key: requestKey,
        });
        setReply("");
        setResponseType("reply");
      }
      pendingRequest.current = null;
      try {
        await onRefresh();
      } catch {
        setRefreshFailed(true);
        setError(
          "Your response was saved, but the latest board could not be loaded. Reopen the board to see the saved changes.",
        );
      }
    } catch (e) {
      setError(errorMessage(e));
      if (
        e instanceof ApiError &&
        ["STALE_REPLY_UPDATE", "STALE_EDIT", "WORKFLOW_LOCKED"].includes(e.code)
      ) {
        await onRefresh().catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className={`review-thread ${thread.status}`}
      open={thread.status === "open"}
      onPointerEnter={() => onHover(thread.id)}
      onPointerLeave={() => onHover(null)}
      onFocusCapture={() => onFocusThread(thread.id)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onFocusThread(null);
        }
      }}
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
        <details className="thread-references">
          <summary>
            {anchors.length
              ? `Referenced items (${anchors.length})`
              : "Entire workflow"}
          </summary>
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
        </details>
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
            <ReplyEvidence event={m.event_data} board={board} />
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
          <ErrorNotice
            title={
              refreshFailed
                ? "Response saved; couldn’t refresh"
                : "Couldn’t save this change"
            }
            message={error}
          />
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
                  ? thread.kind === "finding" && responseType === "reply"
                    ? "Updating blocks…"
                    : "Sending…"
                  : responseType === "reply"
                    ? "Send"
                    : responseType === "resolve"
                      ? "Resolve finding"
                      : "Reject suggestion"}
              </button>
            </div>
            <p className="field-help">
              {thread.kind === "note"
                ? "Add context to this discussion. Notes do not block handoff."
                : responseType === "reply"
                  ? "Send updates the referenced block instructions using your answer. Graph changes remain manual. Resolve or reject the finding when you've made a decision."
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
