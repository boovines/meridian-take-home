"use client";
import { useState } from "react";
import { X, MessageSquare } from "lucide-react";
import type { Board } from "@/domain/canvas";
import type { ReviewState } from "@/domain/review";
import { api, errorMessage } from "@/lib/api";
import { ThreadCard } from "./thread-card";
export function ReviewPanel({
  board,
  state,
  onRefresh,
  onClose,
  onLocate,
  selected,
}: {
  board: Board;
  state: ReviewState;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  onLocate: (kind: "node" | "connection", id: string) => void;
  selected?: { kind: "node" | "connection"; id: string } | null;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [goal, setGoal] = useState(""),
    [note, setNote] = useState(""),
    [showHistory, setShowHistory] = useState(false);
  const active = state.runs.find((r) =>
      ["queued", "running", "awaiting_customer"].includes(r.status),
    ),
    locked = board.workflow.state !== "draft";
  async function act(path: string, data: unknown) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/workflows/${board.workflow.id}/${path}`, "POST", data);
      await onRefresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const findings = state.threads.filter((t) => t.kind === "finding"),
    open = findings.filter((t) => t.status === "open"),
    notes = state.threads.filter((t) => t.kind === "note");
  const latest = state.runs[0];
  return (
    <aside className="inspector review-panel" aria-label="Review and comments">
      <div className="panel-heading">
        Review & comments
        <button
          className="icon-button"
          aria-label="Close review"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <p className="field-help">
        Review the process before implementation. You decide which suggestions
        belong in your workflow.
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {active ? (
        <div className="review-progress" role="status">
          <strong>
            {active.status === "awaiting_customer"
              ? "First, clarify the outcome"
              : "Reviewing your draft…"}
          </strong>
          <p>
            The canvas is read-only during review. You can cancel to resume
            editing.
          </p>
          {active.status === "awaiting_customer" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(`reviews/${active.id}/goal`, {
                  desired_outcome: goal,
                  request_key: crypto.randomUUID(),
                });
              }}
            >
              <label>
                What should this workflow accomplish?
                <textarea
                  required
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  rows={3}
                  maxLength={10000}
                />
              </label>
              <button disabled={busy || !goal.trim()}>
                Confirm outcome and continue
              </button>
            </form>
          )}
          <button
            className="subtle"
            disabled={busy}
            onClick={() => void act(`reviews/${active.id}/cancel`, {})}
          >
            Cancel review
          </button>
        </div>
      ) : (
        <>
          {latest?.status === "failed" && (
            <p role="alert" className="inline-error">
              {latest.error_message || "Review could not finish. Try again."}
            </p>
          )}
          {latest?.status === "cancelled" && (
            <p className="field-help">
              Review cancelled. Your draft is editable again.
            </p>
          )}
          {latest?.status === "completed" && (
            <div className="review-summary">
              <strong>
                {open.length
                  ? `${open.length} finding${open.length === 1 ? "" : "s"} to resolve`
                  : "All findings resolved"}
              </strong>
              <span>
                {state.runs.filter((r) => r.status === "completed").length}{" "}
                completed review
                {state.runs.filter((r) => r.status === "completed").length === 1
                  ? ""
                  : "s"}
              </span>
            </div>
          )}
          {board.workflow.state !== "frozen" && (
            <button
              className="primary full-width"
              disabled={busy || locked}
              onClick={() =>
                void act("reviews", { request_key: crypto.randomUUID() })
              }
            >
              {latest ? "Review draft again" : "Start draft review"}
            </button>
          )}
        </>
      )}
      {open.map((t) => (
        <ThreadCard
          key={t.id}
          thread={t}
          state={state}
          board={board}
          locked={locked || busy}
          onRefresh={onRefresh}
          onLocate={onLocate}
        />
      ))}
      {!active && !latest && (
        <div className="review-intro">
          <MessageSquare size={22} />
          <p>
            Find missing details, unclear exceptions, and steps that may not
            contribute to the outcome.
          </p>
          <p className="field-help">
            This reviews your description. It does not run the process or test
            generated code.
          </p>
        </div>
      )}
      <button
        className="subtle full-width"
        onClick={() => setShowHistory(!showHistory)}
      >
        {showHistory ? "Hide" : "Show"} resolved findings and review history
      </button>
      {showHistory && (
        <div className="review-history">
          {findings
            .filter((t) => t.status === "closed")
            .map((t) => (
              <ThreadCard
                key={t.id}
                thread={t}
                state={state}
                board={board}
                locked={locked || busy}
                onRefresh={onRefresh}
                onLocate={onLocate}
              />
            ))}
          {state.runs.map((r) => (
            <p key={r.id}>
              <span>{r.status}</span> · draft{" "}
              {r.analyzed_content_revision ?? r.started_content_revision}
              <small>
                {r.model} · {new Date(r.created_at).toLocaleString()}
              </small>
            </p>
          ))}
        </div>
      )}
      <div className="inspector-section">
        <h3>Discussion notes</h3>
        <p className="field-help">Notes do not block handoff.</p>
        {notes.map((t) => (
          <ThreadCard
            key={t.id}
            thread={t}
            state={state}
            board={board}
            locked={locked || busy}
            onRefresh={onRefresh}
            onLocate={onLocate}
          />
        ))}
        {!locked && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await api(
                  `/api/workflows/${board.workflow.id}/threads`,
                  "POST",
                  {
                    title: note.trim().slice(0, 100),
                    body: note,
                    node_ids: selected?.kind === "node" ? [selected.id] : [],
                    connection_ids:
                      selected?.kind === "connection" ? [selected.id] : [],
                    request_key: crypto.randomUUID(),
                  },
                );
                setNote("");
                await onRefresh();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              {selected
                ? "Comment on selected item"
                : "Comment on this workflow"}
              <textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={20000}
              />
            </label>
            <button disabled={busy || !note.trim()}>Add note</button>
          </form>
        )}
      </div>
    </aside>
  );
}
