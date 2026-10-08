"use client";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Check, Trash2, X } from "lucide-react";
import {
  type Board,
  type CanvasNode,
  type Connection,
  type Workflow,
  nodeLabels,
} from "@/domain/canvas";
import { ErrorNotice } from "../error-notice";
import { api, ApiError, errorMessage } from "@/lib/api";
import { primitives } from "./primitives";
export type SavedCanvasChange =
  { node: CanvasNode } | { connection: Connection } | { workflow: Workflow };

interface Props {
  board: Board;
  locked: boolean;
  onSaved: (change?: SavedCanvasChange) => Promise<void>;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}
export function NodeInspector({
  node,
  board,
  locked,
  onSaved,
  onClose,
  onDirty,
  onBusy,
}: Props & { node: CanvasNode }) {
  const [title, setTitle] = useState(node.title),
    [instructions, setInstructions] = useState(node.instructions),
    [split, setSplit] = useState(node.split_mode || ""),
    [join, setJoin] = useState(node.join_for_split_id || "");
  const [baseline, setBaseline] = useState(node),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState<CanvasNode | null>(null),
    [confirmDelete, setConfirmDelete] = useState(false);
  // A position save advances the row revision without changing the editor's
  // contents. Rebase only when every process field still matches our baseline;
  // never silently adopt a revision containing someone else's instruction edit.
  const sameContent =
    node.title === baseline.title &&
    node.instructions === baseline.instructions &&
    node.type === baseline.type &&
    node.split_mode === baseline.split_mode &&
    node.join_for_split_id === baseline.join_for_split_id &&
    JSON.stringify(node.config) === JSON.stringify(baseline.config);
  const revision = sameContent
    ? Math.max(node.revision, baseline.revision)
    : baseline.revision;
  const hasChanges =
    title !== baseline.title ||
    instructions !== baseline.instructions ||
    split !== (baseline.split_mode || "") ||
    join !== (baseline.join_for_split_id || "");
  const [saved, setSaved] = useState(false);
  useEffect(() => onDirty(hasChanges), [hasChanges, onDirty]);
  const [target, setTarget] = useState(""),
    [condition, setCondition] = useState("");
  const path = `/api/workflows/${board.workflow.id}/nodes/${node.id}`;
  const incoming = board.connections.filter(
      (c) => c.target_node_id === node.id,
    ),
    outgoing = board.connections.filter((c) => c.source_node_id === node.id);
  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    onBusy(true);
    setError("");
    try {
      const n = await api<CanvasNode>(path, "PATCH", {
        expected_revision: revision,
        title,
        instructions,
        split_mode: split || null,
        join_for_split_id: join || null,
      });
      setBaseline(n);
      setSaved(true);
      onDirty(false);
      setConflict(null);
      await onSaved({ node: n });
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === "STALE_EDIT")
        setConflict((e.details as { current: CanvasNode }).current);
    } finally {
      setSaving(false);
      onBusy(false);
    }
  }
  async function remove() {
    setSaving(true);
    onBusy(true);
    setError("");
    try {
      await api(path, "DELETE", { expected_revision: revision });
      onDirty(false);
      await onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
      onBusy(false);
    }
  }
  async function connect(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    onBusy(true);
    setError("");
    try {
      const edge = await api<Connection>(
        `/api/workflows/${board.workflow.id}/connections`,
        "POST",
        {
          source_node_id: node.id,
          target_node_id: target,
          condition_text: condition,
        },
      );
      setTarget("");
      setCondition("");
      await onSaved({ connection: edge });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
      onBusy(false);
    }
  }
  return (
    <aside className="inspector" aria-label="Block details">
      <div className="panel-heading">
        <span>{nodeLabels[node.type]}</span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close details"
        >
          <X size={16} />
        </button>
      </div>
      <p className="field-help">{primitives[node.type].prompt}</p>
      {error && (
        <ErrorNotice title="Couldn’t save this change" message={error} />
      )}
      {conflict && (
        <div className="conflict-box">
          <strong>Your draft is still below.</strong>
          <p>Saved title: {conflict.title}</p>
          <p className="preserve-lines">
            Saved instructions: {conflict.instructions || "(empty)"}
          </p>
          <button
            onClick={() => {
              setBaseline(conflict);
              setConflict(null);
              setError("");
            }}
          >
            Keep my draft and use this saved revision
          </button>
        </div>
      )}
      <form onSubmit={save}>
        <fieldset disabled={locked || saving}>
          <label>
            Block name
            <input
              value={title}
              maxLength={200}
              onChange={(e) => {
                setTitle(e.target.value);
                onDirty(true);
              }}
            />
          </label>
          <label>
            Instructions
            <textarea
              value={instructions}
              rows={7}
              maxLength={20000}
              onChange={(e) => {
                setInstructions(e.target.value);
                onDirty(true);
              }}
              placeholder={primitives[node.type].prompt}
            />
          </label>
          <label>
            When paths split
            <select
              value={split}
              onChange={(e) => {
                setSplit(e.target.value);
                onDirty(true);
              }}
            >
              <option value="">Choose when needed</option>
              <option value="exclusive">Follow one matching path</option>
              <option value="parallel">Run both paths</option>
            </select>
          </label>
          <label>
            Wait for both paths from
            <select
              value={join}
              onChange={(e) => {
                setJoin(e.target.value);
                onDirty(true);
              }}
            >
              <option value="">No paired merge</option>
              {board.nodes
                .filter((n) => n.id !== node.id && n.split_mode === "parallel")
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title || nodeLabels[n.type]}
                  </option>
                ))}
            </select>
          </label>
          <button
            className={`primary full-width${saved && !hasChanges ? " saved-button" : ""}`}
            disabled={!!conflict || (saved && !hasChanges)}
          >
            {saving ? (
              "Saving…"
            ) : saved && !hasChanges ? (
              <>
                <Check size={15} aria-hidden="true" /> Saved
              </>
            ) : (
              "Save block"
            )}
          </button>
          <span className="sr-only" role="status">
            {saved && !hasChanges ? "Block saved" : ""}
          </span>
        </fieldset>
      </form>
      <div className="inspector-section">
        <h3>
          Connections{" "}
          <span>
            {incoming.length} in · {outgoing.length} out
          </span>
        </h3>
        <p className="field-help">
          Connect the dots on the canvas, or choose the next block here. Return
          paths are welcome.
        </p>
        <form onSubmit={connect}>
          <fieldset disabled={locked || saving}>
            <label>
              Next block
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                required
              >
                <option value="">Choose a block</option>
                {board.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.title || nodeLabels[n.type]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              When should this path be taken?
              <input
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
                maxLength={5000}
                placeholder="e.g. Any required field is missing"
              />
            </label>
            <button disabled={!target}>
              <ArrowRight size={14} /> Add connection
            </button>
          </fieldset>
        </form>
      </div>
      <div className="inspector-section">
        {confirmDelete ? (
          <div>
            <p>
              Remove this block and its {incoming.length + outgoing.length}{" "}
              connected paths?
            </p>
            <div className="form-actions">
              <button onClick={() => setConfirmDelete(false)}>
                Keep block
              </button>
              <button
                className="danger"
                disabled={locked || saving}
                onClick={() => void remove()}
              >
                Remove block
              </button>
            </div>
          </div>
        ) : (
          <button
            className="danger subtle"
            disabled={locked || saving}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={14} /> Remove block
          </button>
        )}
      </div>
    </aside>
  );
}
export function ConnectionInspector({
  connection,
  board,
  locked,
  onSaved,
  onClose,
  onDirty,
  onBusy,
}: Props & { connection: Connection }) {
  const [condition, setCondition] = useState(connection.condition_text),
    [otherwise, setOtherwise] = useState(connection.is_default),
    [revision, setRevision] = useState(connection.revision);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState<Connection | null>(null);
  const path = `/api/workflows/${board.workflow.id}/connections/${connection.id}`;
  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    onBusy(true);
    setError("");
    try {
      const c = await api<Connection>(path, "PATCH", {
        expected_revision: revision,
        condition_text: otherwise ? "" : condition,
        is_default: otherwise,
      });
      setRevision(c.revision);
      onDirty(false);
      await onSaved({ connection: c });
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === "STALE_EDIT")
        setConflict((e.details as { current: Connection }).current);
    } finally {
      setSaving(false);
      onBusy(false);
    }
  }
  async function remove() {
    setSaving(true);
    onBusy(true);
    try {
      await api(path, "DELETE", { expected_revision: revision });
      onDirty(false);
      await onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
      onBusy(false);
    }
  }
  const title = (id: string) =>
    board.nodes.find((n) => n.id === id)?.title || "Untitled block";
  return (
    <aside className="inspector" aria-label="Connection details">
      <div className="panel-heading">
        <span>Connection</span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close details"
        >
          <X size={16} />
        </button>
      </div>
      <h2 className="connection-title">
        {title(connection.source_node_id)} <ArrowRight size={16} />{" "}
        {title(connection.target_node_id)}
      </h2>
      {error && (
        <ErrorNotice title="Couldn’t save this change" message={error} />
      )}
      {conflict && (
        <div className="conflict-box">
          <p>
            Saved condition:{" "}
            {conflict.is_default
              ? "Otherwise"
              : conflict.condition_text || "(empty)"}
          </p>
          <button
            onClick={() => {
              setRevision(conflict.revision);
              setConflict(null);
              setError("Your draft is preserved. Review it and save again.");
            }}
          >
            Use this revision and keep my draft
          </button>
        </div>
      )}
      <form onSubmit={save}>
        <fieldset disabled={locked || saving}>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={otherwise}
              onChange={(e) => {
                setOtherwise(e.target.checked);
                onDirty(true);
              }}
            />{" "}
            Otherwise, if no condition matches
          </label>
          <label>
            Condition
            <textarea
              rows={5}
              value={condition}
              disabled={otherwise}
              maxLength={5000}
              onChange={(e) => {
                setCondition(e.target.value);
                onDirty(true);
              }}
              placeholder="Describe when to follow this path."
            />
          </label>
          <p className="field-help">
            A single unconditional path can stay blank. At a decision, label
            each path clearly.
          </p>
          <button className="primary full-width" disabled={!!conflict}>
            {saving ? "Saving…" : "Save connection"}
          </button>
        </fieldset>
      </form>
      <div className="inspector-section">
        <button
          className="danger subtle"
          disabled={locked || saving}
          onClick={() => void remove()}
        >
          <Trash2 size={14} /> Remove connection
        </button>
      </div>
    </aside>
  );
}
