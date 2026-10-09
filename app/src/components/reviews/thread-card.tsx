"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Maximize2, X } from "lucide-react";
import { ConversationMessage } from "./conversation-message";
import { ReplyChanges } from "./reply-changes";
import { ErrorNotice } from "../error-notice";
import { api, ApiError, errorMessage } from "@/lib/api";
import {
  findingLabel,
  type DiscussionThread,
  type ReviewState,
} from "@/domain/review";

import type { Board } from "@/domain/canvas";
export function ThreadCard({
  opened,
  onExpandedChange,
  thread,
  state,
  board,
  locked,
  onRefresh,
  onLocate,
  onHover,
  onFocusThread,
}: {
  opened?: boolean;
  onExpandedChange?: (open: boolean) => void;
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
  const [proposalDrafts, setProposalDrafts] = useState<Record<string, string>>(
    {},
  );
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = opened ?? localExpanded;
  const setExpanded = (value: boolean) =>
    onExpandedChange ? onExpandedChange(value) : setLocalExpanded(value);
  const dialog = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (expanded) dialog.current?.showModal();
    else if (dialog.current?.open) {
      dialog.current.close();
      expandButton.current?.focus();
    }
  }, [expanded]);
  const pendingRequest = useRef<{ signature: string; key: string } | null>(
    null,
  );
  const messages = state.messages.filter((m) => m.thread_id === thread.id),
    anchors = state.anchors.filter((a) => a.thread_id === thread.id),
    proposal = thread.proposed_patch;
  const current = board.nodes.find((n) => n.id === thread.proposed_node_id),
    stale = !!proposal && current?.revision !== thread.proposed_node_revision;
  async function submit(
    action:
      | "reply"
      | "resolve"
      | "reject"
      | "reopen"
      | "apply"
      | "accept-proposal"
      | "reject-proposal",
    proposalId?: string,
    nodeId?: string,
    instructions?: string,
    title?: string,
  ) {
    setBusy(true);
    setError("");
    setRefreshFailed(false);
    try {
      const signature = JSON.stringify({
        action,
        proposalId,
        nodeId,
        instructions,
        title,
        reply,
        revision: thread.revision,
      });
      if (pendingRequest.current?.signature !== signature)
        pendingRequest.current = { signature, key: crypto.randomUUID() };
      const requestKey = pendingRequest.current.key;
      const base = `/api/workflows/${board.workflow.id}/threads/${thread.id}`;
      if (action === "accept-proposal" || action === "reject-proposal") {
        await api(`${base}/proposals/${proposalId}`, "POST", {
          decision: action === "accept-proposal" ? "accept" : "reject",
          node_id: nodeId,
          ...(instructions !== undefined ? { instructions } : {}),
          ...(title !== undefined ? { title } : {}),
          expected_revision: thread.revision,
          request_key: requestKey,
        });
      } else if (action === "reply") {
        await api(`${base}/messages`, "POST", {
          body: reply,
          expected_revision: thread.revision,
          parent_message_id: messages.at(-1)?.id || null,
          request_key: requestKey,
        });
        setReply("");
      } else {
        await api(
          thread.engineer_request
            ? `/api/workflows/${board.workflow.id}/change-requests/${thread.id}`
            : `${base}/actions`,
          "POST",
          {
            action,
            reason: action === "reopen" ? "" : reply,
            expected_revision: thread.revision,
            request_key: requestKey,
          },
        );
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
        [
          "STALE_REPLY_UPDATE",
          "STALE_EDIT",
          "WORKFLOW_LOCKED",
          "STALE_PROPOSAL",
          "PROPOSAL_SUPERSEDED",
          "PROPOSAL_DECIDED",
        ].includes(e.code)
      ) {
        await onRefresh().catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  }
  const conversation = (
    <div className="thread-content">
      {thread.engineer_request && (
        <div className="review-summary">
          <strong>
            Engineer request · frozen v
            {thread.engineer_request.source_version_number}
          </strong>
          <p className="field-help">
            The engineer’s original request is preserved below. Accepted wording
            must be saved to the draft before handoff.
          </p>
          {board.workflow.state === "frozen" &&
            thread.status === "open" &&
            thread.engineer_request.source_frozen_spec_id ===
              board.workflow.current_frozen_spec_id && (
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await api(
                      `/api/workflows/${board.workflow.id}/revisions`,
                      "POST",
                      {
                        source_frozen_spec_id:
                          thread.engineer_request!.source_frozen_spec_id,
                      },
                    );
                    await onRefresh();
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Start revision
              </button>
            )}
        </div>
      )}
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
      <div className="conversation-messages" aria-label="Conversation messages">
        {messages.map((m) => (
          <ConversationMessage key={m.id} message={m}>
            <ReplyChanges
              message={m}
              messages={messages}
              board={board}
              thread={thread}
              disabled={locked || busy || board.workflow.state !== "draft"}
              drafts={proposalDrafts}
              onDraft={(key, text) =>
                setProposalDrafts((current) => ({ ...current, [key]: text }))
              }
              onDecision={(decision, id, nodeId, instructions, title) =>
                void submit(
                  decision === "accept" ? "accept-proposal" : "reject-proposal",
                  id,
                  nodeId,
                  instructions,
                  title,
                )
              }
            />
          </ConversationMessage>
        ))}
      </div>
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
              This block changed after the suggestion. Compare the text and edit
              it manually, or request another review.
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
                {(thread.kind === "finding" || thread.engineer_request) && (
                  <>
                    <option
                      value="resolve"
                      disabled={
                        !!thread.engineer_request &&
                        board.workflow.state !== "draft"
                      }
                    >
                      Resolve
                    </option>
                    <option value="reject">Reject</option>
                  </>
                )}
              </select>
            </label>
            <button className="primary" disabled={busy || !reply.trim()}>
              {busy
                ? thread.kind === "finding" && responseType === "reply"
                  ? "Preparing proposal…"
                  : "Sending…"
                : responseType === "reply"
                  ? "Send"
                  : responseType === "resolve"
                    ? thread.engineer_request
                      ? "Resolve request"
                      : "Resolve finding"
                    : thread.engineer_request
                      ? "Reject request"
                      : "Reject suggestion"}
            </button>
          </div>
          <p className="field-help">
            {thread.kind === "note" && !thread.engineer_request
              ? "Add context to this discussion. Notes do not block handoff."
              : responseType === "reply"
                ? "AI will propose a diff from your answer. You choose whether to accept it; blocks stay unchanged until then."
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
  );
  return (
    <details
      className={`review-thread ${thread.status}`}
      open={expanded || thread.status === "open"}
      onPointerEnter={() => onHover(thread.id)}
      onPointerLeave={() => onHover(null)}
      onFocusCapture={() => onFocusThread(thread.id)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          onFocusThread(null);
      }}
    >
      <summary>
        <span className="thread-heading-row">
          <span className="thread-heading-status">
            <ChevronRight
              size={12}
              className="thread-chevron"
              aria-hidden="true"
            />
            <span
              className={`thread-status ${findingLabel(thread, state.messages).toLowerCase()}`}
            >
              {thread.kind === "note" && !thread.engineer_request
                ? "Note"
                : findingLabel(thread, state.messages)}
            </span>
          </span>
          <button
            ref={expandButton}
            type="button"
            className="icon-button expand-conversation"
            aria-label={`Expand conversation: ${thread.title}`}
            title="Expand conversation"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setExpanded(true);
            }}
          >
            <Maximize2 size={14} />
          </button>
        </span>
        <strong>{thread.title}</strong>
      </summary>
      {!expanded && conversation}
      <dialog
        ref={dialog}
        className="review-dialog"
        aria-labelledby={`conversation-title-${thread.id}`}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => element.getClientRects().length > 0);
          const first = controls[0],
            last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
        onCancel={(event) => {
          event.preventDefault();
          setExpanded(false);
        }}
      >
        {expanded && (
          <header className="conversation-header">
            <div>
              <span className="eyebrow">Review conversation</span>
              <h2 id={`conversation-title-${thread.id}`}>{thread.title}</h2>
            </div>
            <button
              className="icon-button"
              aria-label="Close conversation"
              onClick={() => setExpanded(false)}
            >
              <X size={18} />
            </button>
          </header>
        )}
        {expanded && conversation}
      </dialog>
    </details>
  );
}
