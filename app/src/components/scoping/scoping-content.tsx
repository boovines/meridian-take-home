"use client";
import { useState } from "react";
import { ArrowUp, Check, Sparkles, StickyNote, GitBranch } from "lucide-react";
import type { Board } from "@/domain/canvas";
import { scopeReady } from "@/domain/scoping";
import type { ScopingController } from "./use-scoping";
import { ScopeSummary } from "./scope-summary";
import { ScaffoldPreview } from "./scaffold-preview";
export interface ScopingContentProps {
  controller: ScopingController;
  board: Board;
  onApplied: (board: Board) => void;
  onReview: () => void;
  expanded: boolean;
}
export function ScopingContent({
  controller: c,
  board,
  onApplied,
  onReview,
}: ScopingContentProps) {
  const [tab, setTab] = useState<"note" | "conversation" | "preview">("note");
  const [answer, setAnswer] = useState("");
  const [historyId, setHistoryId] = useState("");
  const state = c.state,
    s = state?.session;
  const sv = state?.versions.find((v) => v.id === s?.current_scope_id);
  const scope = sv && "scope" in sv.data ? sv.data.scope : null;
  const scopes = state?.versions.filter((v) => v.kind === "scope") || [];
  const previews = state?.versions.filter((v) => v.kind === "preview") || [];
  const pv =
    state?.versions.find(
      (v) => v.id === (historyId || s?.current_preview_id),
    ) || previews.at(-1);
  const previewScopeVersion = state?.versions.find(
    (v) => v.id === pv?.scope_id,
  );
  const previewScope =
    previewScopeVersion && "scope" in previewScopeVersion.data
      ? previewScopeVersion.data.scope
      : null;
  const graph = pv && "graph" in pv.data ? pv.data.graph : null;
  const noteChanged =
    !!s && (c.dirty || s.note_revision !== s.incorporated_note_revision);
  const empty = !board.nodes.length && !board.connections.length;
  const editable = board.workflow.state === "draft";
  const enabled = editable && empty && !s?.applied_preview_id;
  const disabled = c.busy || c.active || !enabled || !!c.conflict;
  const currentPreview = pv?.id === s?.current_preview_id && !noteChanged;
  async function send(
    action: "start" | "answer" | "notes" | "revise" | "preview",
    body = "",
  ) {
    if (await c.request(action, body)) {
      setAnswer("");
      setHistoryId("");
      setTab(action === "preview" ? "preview" : "conversation");
    }
  }
  const note = (
    <section className="scoping-note-section" aria-label="Process notes">
      <div className="scoping-section-heading">
        <h3>Your process, in your words</h3>
        <span role="status">
          {c.saving ? (
            "Saving…"
          ) : c.dirty ? (
            "Unsaved"
          ) : (
            <>
              <Check size={12} /> Saved
            </>
          )}
        </span>
      </div>
      <p className="field-help">
        Capture the messy details: what starts the work, who is involved, and
        what a good result looks like.
      </p>
      <label className="scoping-note-label">
        Process notes
        <textarea
          aria-describedby="scoping-note-help"
          value={c.note}
          maxLength={50000}
          disabled={!editable}
          onChange={(e) => c.changeNote(e.target.value)}
          placeholder="Start anywhere. Describe what happens today, the exceptions, and what you wish were easier…"
        />
      </label>
      <p id="scoping-note-help" className="field-help">
        Saved automatically. The agent reads your note only when you ask.
      </p>
      {c.conflict && (
        <div className="scoping-conflict" role="alert">
          <strong>
            {c.recovered
              ? "Recover your unsaved note"
              : "This note changed elsewhere"}
          </strong>
          <p>
            Your text is still in the editor. Compare before saving over the
            current version.
          </p>
          <details>
            <summary>View saved note</summary>
            <p>{c.conflict.note || "The saved note is empty."}</p>
          </details>
          <div className="button-row">
            <button onClick={() => void c.recover(true)} disabled={!editable}>
              Keep my text and save
            </button>
            <button onClick={() => void c.recover(false)}>
              Use saved note
            </button>
          </div>
        </div>
      )}
      {enabled && (
        <button
          className="primary"
          disabled={
            disabled ||
            !c.note.trim() ||
            (!!s?.incorporated_note_revision && !noteChanged)
          }
          onClick={() =>
            void send(s?.incorporated_note_revision ? "notes" : "start")
          }
        >
          <Sparkles size={15} />
          {s?.incorporated_note_revision
            ? "Use updated notes"
            : "Help build workflow"}
        </button>
      )}
      {!empty && !s?.applied_preview_id && (
        <p className="field-help">
          Initial generation is available on empty boards. You can keep using
          this note.
        </p>
      )}
      {s?.applied_preview_id && (
        <p className="field-help">
          Your initial workflow is on the canvas. Changes to this note do not
          change its blocks.
        </p>
      )}
    </section>
  );
  const conversation = (
    <section
      className="scoping-conversation-section"
      aria-label="Scoping conversation"
    >
      <div className="scoping-section-heading">
        <h3>Shape the workflow</h3>
        <span>Scoping conversation</span>
      </div>
      {!state?.messages.length && (
        <div className="scoping-welcome">
          <Sparkles size={24} />
          <h3>Start with what you know</h3>
          <p>
            The agent will ask about the decisions that matter, then suggest a
            connected workflow for you to approve.
          </p>
        </div>
      )}
      <ol className="scoping-messages">
        {state?.messages.map((m) => (
          <li key={m.id} className={`scoping-message ${m.author}`}>
            <span>{m.author === "agent" ? "Workflow assistant" : "You"}</span>
            <p>{m.body}</p>
          </li>
        ))}
      </ol>
      {c.active && (
        <div className="scoping-progress" role="status">
          <span>
            {state?.operation?.status === "queued"
              ? "Queued for the agent…"
              : "The agent is working…"}{" "}
            You can close this note and return later.
          </span>
          <button onClick={() => void c.cancel()} disabled={c.busy}>
            Cancel
          </button>
        </div>
      )}
      {state?.operation?.status === "failed" && (
        <p role="alert" className="inline-error">
          {state.operation.error_message}
        </p>
      )}
      {state?.operation?.status === "cancelled" && (
        <p className="field-help">
          Response cancelled. Your notes and previous previews are preserved.
        </p>
      )}
      {scope && <ScopeSummary scope={scope} />}
      {scopes.length > 1 && (
        <details className="scoping-history">
          <summary>Earlier scope summaries ({scopes.length - 1})</summary>
          {scopes
            .filter((v) => v.id !== s?.current_scope_id)
            .map((v, i) => (
              <details key={v.id}>
                <summary>
                  Scope {i + 1} · {new Date(v.created_at).toLocaleString()}
                </summary>
                {"scope" in v.data && <ScopeSummary scope={v.data.scope} />}
              </details>
            ))}
        </details>
      )}
      {enabled && !!state?.messages.length && (
        <>
          {noteChanged ? (
            <div className="scoping-notice">
              <p>
                Your note has changed. Incorporate it before continuing or
                applying a preview.
              </p>
              <button
                disabled={c.busy || !!c.conflict}
                onClick={() => void send("notes")}
              >
                Use updated notes
              </button>
            </div>
          ) : (
            <>
              {scope && scopeReady(scope) && (
                <div className="scoping-ready">
                  <strong>Ready for a first draft</strong>
                  <p>
                    Generate a preview to confirm the scope and assumptions
                    above. Nothing is added until you apply it.
                  </p>
                  <button
                    className="primary"
                    disabled={disabled}
                    onClick={() => void send("preview")}
                  >
                    <GitBranch size={15} />
                    Generate preview
                  </button>
                </div>
              )}
              <form
                className="scoping-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(graph ? "revise" : "answer", answer);
                }}
              >
                <label>
                  Your reply
                  <textarea
                    value={answer}
                    disabled={disabled}
                    onChange={(e) => setAnswer(e.target.value)}
                    maxLength={20000}
                    placeholder={
                      scope && scopeReady(scope)
                        ? "Add context or request a change…"
                        : "Share the details, or say what is still unknown…"
                    }
                    rows={3}
                  />
                </label>
                <button
                  type="submit"
                  className="primary"
                  disabled={disabled || !answer.trim()}
                >
                  <ArrowUp size={15} />
                  Send reply
                </button>
              </form>
              {!scope && !c.active && (
                <button disabled={disabled} onClick={() => void send("notes")}>
                  Retry from saved notes
                </button>
              )}
            </>
          )}
        </>
      )}
      {s?.applied_preview_id && (
        <div className="scoping-ready">
          <strong>
            {state?.needs_review ? "Not reviewed" : "Scaffold applied"}
          </strong>
          <p>
            Inspect and edit the blocks on your canvas, then run the normal
            draft review. Scoping does not replace review.
          </p>
          <button onClick={onReview}>Open review & comments</button>
        </div>
      )}
    </section>
  );
  const preview = (
    <section className="scoping-preview-section" aria-label="Scaffold preview">
      <div className="scoping-section-heading">
        <h3>Workflow preview</h3>
        <span>
          {previews.length
            ? `${previews.length} version${previews.length > 1 ? "s" : ""}`
            : "Not generated"}
        </span>
      </div>
      {previews.length > 0 && (
        <label>
          Preview history
          <select
            value={pv?.id || ""}
            onChange={(e) => setHistoryId(e.target.value)}
          >
            {previews.map((v, i) => (
              <option value={v.id} key={v.id}>
                Version {i + 1}
                {v.id === s?.applied_preview_id
                  ? " · Applied"
                  : v.id === s?.current_preview_id
                    ? " · Current"
                    : " · Previous"}
              </option>
            ))}
          </select>
        </label>
      )}
      {graph && previewScope ? (
        <>
          {!currentPreview && !s?.applied_preview_id && (
            <p className="scoping-notice">
              This is a previous preview. Generate a new preview from your
              current scope before applying.
            </p>
          )}
          <ScaffoldPreview
            key={pv!.id}
            graph={graph}
            scope={previewScope}
            workflow={board.workflow}
          />
          {!!previewScope.unresolved.length && (
            <div className="scoping-notice">
              <strong>Carried into normal review</strong>
              <ul>
                {previewScope.unresolved.map((u) => (
                  <li key={u.key}>{u.question}</li>
                ))}
              </ul>
            </div>
          )}
          {!s?.applied_preview_id && (
            <div className="scoping-preview-actions">
              <button
                className="primary"
                disabled={disabled || !currentPreview}
                onClick={() =>
                  void c.apply(board, onApplied).then((ok) => {
                    if (ok) setTab("conversation");
                  })
                }
              >
                Apply workflow
              </button>
              <button onClick={() => setTab("conversation")}>
                Request changes
              </button>
              <p className="field-help">
                Adds the entire workflow to an empty board. Normal AI review is
                still required.
              </p>
              {!empty && (
                <p role="alert">
                  The board is no longer empty. Your preview is preserved.
                </p>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="scoping-welcome">
          <GitBranch size={24} />
          <h3>A connected first draft</h3>
          <p>
            Once the scope is clear, generate a preview to inspect every block
            and path before applying.
          </p>
          <button onClick={() => setTab("conversation")}>
            Continue conversation
          </button>
        </div>
      )}
    </section>
  );
  if (!state)
    return (
      <div className="scoping-loading">
        <p role="status">Opening your process note…</p>
        {c.error && <p role="alert">{c.error}</p>}
        <button onClick={() => void c.refresh().catch(() => {})}>Retry</button>
      </div>
    );
  return (
    <div className="scoping-content">
      {c.error && (
        <div role="alert" className="scoping-error">
          {c.error}
          {c.dirty && !c.conflict && (
            <button onClick={() => void c.retrySave()}>
              Retry saving note
            </button>
          )}
        </div>
      )}
      <nav className="scoping-tabs" aria-label="Note sections">
        {(
          [
            ["note", "Notes", StickyNote],
            ["conversation", "Conversation", Sparkles],
            ["preview", "Preview", GitBranch],
          ] as const
        ).map(([id, label, Icon]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            <Icon size={15} />
            {label}
          </button>
        ))}
      </nav>
      <div className="scoping-panels">
        <div className={`scoping-note-pane ${tab === "note" ? "active" : ""}`}>
          {note}
        </div>
        <div
          className={`scoping-conversation-pane ${tab === "conversation" ? "active" : ""}`}
        >
          {conversation}
        </div>
        <div
          className={`scoping-preview-pane ${tab === "preview" ? "active" : ""}`}
        >
          {preview}
        </div>
      </div>
    </div>
  );
}
