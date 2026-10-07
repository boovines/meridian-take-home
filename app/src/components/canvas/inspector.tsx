"use client";
import { useState, type FormEvent } from "react";
import { ArrowRight, Trash2, X } from "lucide-react";
import {
  type Board,
  type CanvasNode,
  type Connection,
  nodeLabels,
} from "@/domain/canvas";
import { api, ApiError, errorMessage } from "@/lib/api";
import { primitives } from "./primitives";
interface Props {
  board: Board;
  locked: boolean;
  onSaved: () => Promise<void>;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
}
export function NodeInspector({
  node,
  board,
  locked,
  onSaved,
  onClose,
  onDirty,
}: Props & { node: CanvasNode }) {
  const [title, setTitle] = useState(node.title),
    [instructions, setInstructions] = useState(node.instructions),
    [split, setSplit] = useState(node.split_mode || ""),
    [join, setJoin] = useState(node.join_for_split_id || "");
  const [revision, setRevision] = useState(node.revision),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState<CanvasNode | null>(null),
    [confirmDelete, setConfirmDelete] = useState(false);
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
    setError("");
    try {
      const n = await api<CanvasNode>(path, "PATCH", {
        expected_revision: revision,
        title,
        instructions,
        split_mode: split || null,
        join_for_split_id: join || null,
      });
      setRevision(n.revision);
      onDirty(false);
      setConflict(null);
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === "STALE_EDIT")
        setConflict((e.details as { current: CanvasNode }).current);
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    setSaving(true);
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
    }
  }
  async function connect(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(`/api/workflows/${board.workflow.id}/connections`, "POST", {
        source_node_id: node.id,
        target_node_id: target,
        condition_text: condition,
      });
      setTarget("");
      setCondition("");
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
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
        <div className="inline-error" role="alert">
          {error}
        </div>
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
              setRevision(conflict.revision);
              setConflict(null);
              setError(
                "Review your draft below, then save to replace the version you just compared.",
              );
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
          <button className="primary full-width" disabled={!!conflict}>
            {saving ? "Saving…" : "Save block"}
          </button>
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
    setError("");
    try {
      const c = await api<Connection>(path, "PATCH", {
        expected_revision: revision,
        condition_text: otherwise ? "" : condition,
        is_default: otherwise,
      });
      setRevision(c.revision);
      onDirty(false);
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === "STALE_EDIT")
        setConflict((e.details as { current: Connection }).current);
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    setSaving(true);
    try {
      await api(path, "DELETE", { expected_revision: revision });
      onDirty(false);
      await onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
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
        <div role="alert" className="inline-error">
          {error}
        </div>
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
