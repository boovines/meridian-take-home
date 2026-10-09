"use client";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Check,
  ChevronDown,
  Plus,
  X,
  MessageSquare,
  LockKeyhole,
} from "lucide-react";
import type { Connection as FlowConnection } from "@xyflow/react";
import Workspace from "../shell/workspace";
import { ProcessCanvas } from "./process-canvas";
import {
  NodeInspector,
  ConnectionInspector,
  type SavedCanvasChange,
} from "./inspector";
import { primitives } from "./primitives";
import { api, ApiError, errorMessage } from "@/lib/api";
import {
  type Board,
  type CanvasNode,
  type Connection,
  type NodeType,
  type Workflow,
  nodeLabels,
  nodeTypes,
} from "@/domain/canvas";
import { useReview } from "../reviews/use-review";
import { RevisionNotice } from "../process-revisions/revision-notice";
import { ReviewPanel } from "../reviews/review-panel";
import { FreezeDialog } from "../reviews/freeze-dialog";
export function BoardClient({
  id,
  openRequests = false,
}: {
  id: string;
  openRequests?: boolean;
}) {
  const [board, setBoard] = useState<Board | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  const [selection, setSelection] = useState<{
      kind: "node" | "connection";
      id: string;
    } | null>(null),
    [goalOpen, setGoalOpen] = useState(false);
  const [highlightedThread, setHighlightedThread] = useState<string | null>(
    null,
  );
  const [dirty, setDirty] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(
    openRequests ? "first_request" : null,
  );
  const [reviewOpen, setReviewOpen] = useState(openRequests),
    [freezeOpen, setFreezeOpen] = useState(false);
  // A response started before a newer mutation must not replace its result.
  const boardVersion = useRef(0);
  const load = useCallback(async () => {
    const version = ++boardVersion.current;
    const next = await api<Board>(`/api/workflows/${id}`);
    if (version === boardVersion.current) setBoard(next);
  }, [id]);
  const applySaved = useCallback((change: SavedCanvasChange) => {
    boardVersion.current++;
    setBoard((current) => {
      if (!current) return current;
      if ("node" in change) {
        const exists = current.nodes.some((node) => node.id === change.node.id);
        return {
          ...current,
          nodes: exists
            ? current.nodes.map((node) =>
                node.id === change.node.id ? change.node : node,
              )
            : [...current.nodes, change.node],
        };
      }
      if ("connection" in change) {
        const exists = current.connections.some(
          (edge) => edge.id === change.connection.id,
        );
        return {
          ...current,
          connections: exists
            ? current.connections.map((edge) =>
                edge.id === change.connection.id ? change.connection : edge,
              )
            : [...current.connections, change.connection],
        };
      }
      return { ...current, workflow: change.workflow };
    });
    setStatus("All changes saved");
  }, []);
  const onBusy = useCallback((saving: boolean) => {
    if (saving) boardVersion.current++;
    setBusy(saving);
  }, []);
  const review = useReview(id, load);
  useEffect(() => {
    let active = true;
    api<Board>(`/api/workflows/${id}`)
      .then((b) => {
        if (active) setBoard(b);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [id]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function canLeave() {
    if (busy) return false;
    if (dirty && !window.confirm("Discard the unsaved changes in this panel?"))
      return false;
    setDirty(false);
    return true;
  }
  function select(kind: "node" | "connection", nodeId: string) {
    if (selection?.kind === kind && selection.id === nodeId && !reviewOpen)
      return;
    if (canLeave()) {
      setReviewOpen(false);
      setSelection({ kind, id: nodeId });
      setGoalOpen(false);
    }
  }
  async function mutate(fn: () => Promise<void>) {
    boardVersion.current++;
    setBusy(true);
    setError("");
    setStatus("Saving…");
    try {
      await fn();
      setStatus("All changes saved");
    } catch (e) {
      setError(errorMessage(e));
      setStatus("Change not saved");
    } finally {
      setBusy(false);
    }
  }
  async function add(type: NodeType, position?: { x: number; y: number }) {
    if (!board || !canLeave()) return;
    await mutate(async () => {
      const n = await api<CanvasNode>(`/api/workflows/${id}/nodes`, "POST", {
        type,
        title: nodeLabels[type],
        x: position?.x ?? 80 + (board.nodes.length % 3) * 270,
        y: position?.y ?? 60 + Math.floor(board.nodes.length / 3) * 190,
      });
      applySaved({ node: n });
      setReviewOpen(false);
      setSelection({ kind: "node", id: n.id });
      setGoalOpen(false);
    });
  }
  async function connect(c: FlowConnection) {
    if (!c.source || !c.target) return;
    await mutate(async () => {
      const edge = await api<Connection>(
        `/api/workflows/${id}/connections`,
        "POST",
        { source_node_id: c.source, target_node_id: c.target },
      );
      applySaved({ connection: edge });
      if (canLeave()) setSelection({ kind: "connection", id: edge.id });
    });
  }
  async function move(n: CanvasNode, x: number, y: number) {
    await mutate(async () => {
      const saved = await api<CanvasNode>(
        `/api/workflows/${id}/nodes/${n.id}`,
        "PATCH",
        {
          expected_revision: n.revision,
          x,
          y,
        },
      );
      applySaved({ node: saved });
    });
  }
  const selectedNode = board?.nodes.find(
      (n) => selection?.kind === "node" && n.id === selection.id,
    ),
    selectedConnection = board?.connections.find(
      (c) => selection?.kind === "connection" && c.id === selection.id,
    );
  const counts: Record<string, number> = {};
  for (const t of review.state.threads.filter(
    (t) => t.kind === "finding" && t.status === "open",
  ))
    for (const a of review.state.anchors.filter((a) => a.thread_id === t.id)) {
      const id = a.node_id || a.connection_id!;
      counts[id] = (counts[id] || 0) + 1;
    }
  const openReviews = () => {
    if (canLeave()) {
      setReviewOpen(true);
      setGoalOpen(false);
    }
  };
  const locked = busy || board?.workflow.state !== "draft";
  const inspectorProps = {
    locked,
    onSaved: async (change?: SavedCanvasChange) => {
      if (change) applySaved(change);
      else await review.refresh();
      setStatus("All changes saved");
    },
    onClose: () => {
      if (canLeave()) setSelection(null);
    },
    onDirty: setDirty,
    onBusy,
  };
  return (
    <Workspace
      title={board?.workflow.name || "Workflow"}
      subtitle="Describe the work. Connect the steps. Make the exceptions explicit."
      actions={
        <>
          <span className="save-status" role="status">
            {!dirty && status === "All changes saved" && <Check size={13} />}{" "}
            {dirty ? "Unsaved changes" : status}
          </span>
          <span className="status-pill">
            {board?.workflow.state || "loading"}
          </span>
        </>
      }
    >
      <main className="board-workspace">
        {review.error && (
          <div role="alert" className="error-banner">
            {review.error}
            <button onClick={() => void review.refresh().catch(() => {})}>
              Retry loading review
            </button>
          </div>
        )}
        <RevisionNotice
          count={
            review.state.threads.filter(
              (t) => t.engineer_request && t.status === "open",
            ).length
          }
          onOpen={() => {
            openReviews();
            setConversationId("first_request");
          }}
        />
        {board?.workflow.base_frozen_spec_id &&
          board.workflow.state !== "frozen" && (
            <div className="state-banner">
              Editing draft v{board.workflow.process_version} · based on frozen
              v{(board.workflow.process_version ?? 2) - 1}. Engineering
              continues from the approved version.
            </div>
          )}
        {board?.workflow.state === "reviewing" && (
          <div className="state-banner" role="status">
            Review in progress. The canvas is temporarily read-only.
            <button onClick={openReviews}>View review</button>
          </div>
        )}
        {board?.workflow.state === "frozen" && (
          <div className="state-banner">
            <LockKeyhole size={15} /> Frozen v
            {board.workflow.process_version ?? 1} for engineer handoff. This
            process and its review decisions are saved.
            <Link className="button-link" href={`/workflows/${id}/engineer`}>
              Open engineer workspace
            </Link>
          </div>
        )}
        {freezeOpen && (
          <FreezeDialog
            workflowId={id}
            onClose={() => setFreezeOpen(false)}
            onFrozen={review.refresh}
            onLocate={(issue) =>
              select(
                issue.node_id ? "node" : "connection",
                (issue.node_id || issue.connection_id)!,
              )
            }
          />
        )}
        {error && (
          <div role="alert" className="error-banner">
            {error}
            <button
              onClick={() => {
                void load()
                  .then(() => setError(""))
                  .catch((e) => setError(errorMessage(e)));
              }}
            >
              Reload saved board
            </button>
          </div>
        )}
        {!board ? (
          <div className="loading-state" role="status">
            {error ? "Unable to open workflow." : "Opening your workflow…"}
          </div>
        ) : (
          <>
            <div className="canvas-toolbar">
              <div className="canvas-tabs">
                <span className="current-tab">Whiteboard</span>
                <span className="toolbar-note">Map your process</span>
              </div>
              <button
                className="subtle"
                onClick={() => {
                  if (canLeave()) {
                    setReviewOpen(false);
                    setGoalOpen(!goalOpen);
                    setSelection(null);
                  }
                }}
              >
                Workflow details <ChevronDown size={14} />
              </button>
              <div className="button-row">
                <button onClick={openReviews} aria-pressed={reviewOpen}>
                  <MessageSquare size={14} /> Review & comments{" "}
                  {review.state.threads.filter(
                    (t) => t.kind === "finding" && t.status === "open",
                  ).length || ""}
                </button>
                <button
                  className="primary"
                  disabled={busy || board.workflow.state !== "draft"}
                  onClick={() => {
                    if (canLeave()) {
                      setSelection(null);
                      setGoalOpen(false);
                      setFreezeOpen(true);
                    }
                  }}
                >
                  <LockKeyhole size={14} /> Freeze
                </button>
              </div>
            </div>
            <div className="canvas-layout">
              <aside className="palette" aria-label="Blocks">
                <div className="panel-heading">
                  Blocks <span>{board.nodes.length}</span>
                </div>
                <p className="field-help">
                  Drag a block onto the canvas, or click to add it.
                </p>
                {nodeTypes.map((type) => {
                  const Icon = primitives[type].icon;
                  return (
                    <button
                      className={`palette-item ${type}`}
                      key={type}
                      disabled={locked}
                      draggable={!locked}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(
                          "application/meridian-block",
                          type,
                        );
                        event.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => void add(type)}
                      aria-label={`Add ${nodeLabels[type]}`}
                    >
                      <span className="primitive-icon">
                        <Icon size={17} />
                      </span>
                      <span>
                        <strong>{nodeLabels[type]}</strong>
                        <small>{primitives[type].description}</small>
                      </span>
                      <Plus size={13} />
                    </button>
                  );
                })}
                <div className="palette-hint">
                  Connect a block’s bottom dot to another block’s top dot. Click
                  a line to describe its condition.
                </div>
              </aside>
              <section className="canvas-stage" aria-label="Process canvas">
                <ProcessCanvas
                  board={board}
                  findingCounts={counts}
                  reviewHighlight={
                    reviewOpen && highlightedThread
                      ? {
                          nodeIds: review.state.anchors
                            .filter(
                              (a) =>
                                a.thread_id === highlightedThread && a.node_id,
                            )
                            .map((a) => a.node_id!),
                          connectionIds: review.state.anchors
                            .filter(
                              (a) =>
                                a.thread_id === highlightedThread &&
                                a.connection_id,
                            )
                            .map((a) => a.connection_id!),
                          wholeWorkflow: !review.state.anchors.some(
                            (a) => a.thread_id === highlightedThread,
                          ),
                        }
                      : undefined
                  }
                  onOpenReviews={openReviews}
                  selected={selection?.id}
                  locked={locked}
                  onSelect={select}
                  onConnect={(c) => void connect(c)}
                  onMove={(n, x, y) => void move(n, x, y)}
                  onAdd={(type, position) => void add(type, position)}
                />
                {board.nodes.length === 0 && (
                  <div className="canvas-empty">
                    <span className="eyebrow">Start here</span>
                    <h2>How does this process begin?</h2>
                    <p>
                      Add a Trigger, then build out the steps as you would
                      explain them to a colleague.
                    </p>
                    <button
                      onClick={() => void add("trigger")}
                      disabled={locked}
                    >
                      <Plus size={15} /> Add a Trigger
                    </button>
                  </div>
                )}
              </section>
              {reviewOpen ? (
                <ReviewPanel
                  conversationId={conversationId}
                  onConversationChange={setConversationId}
                  board={board}
                  state={review.state}
                  onRefresh={review.refresh}
                  selected={selection}
                  onClose={() => setReviewOpen(false)}
                  onLocate={select}
                  onHighlight={setHighlightedThread}
                />
              ) : selectedNode ? (
                <NodeInspector
                  key={selectedNode.id}
                  node={selectedNode}
                  board={board}
                  {...inspectorProps}
                />
              ) : selectedConnection ? (
                <ConnectionInspector
                  key={selectedConnection.id}
                  connection={selectedConnection}
                  board={board}
                  {...inspectorProps}
                />
              ) : goalOpen ? (
                <WorkflowDetails
                  key={board.workflow.id}
                  workflow={board.workflow}
                  locked={locked}
                  onSaved={applySaved}
                  onBusy={onBusy}
                  onDirty={setDirty}
                  onClose={() => {
                    if (canLeave()) setGoalOpen(false);
                  }}
                />
              ) : null}
            </div>
            <footer className="canvas-footer">
              <span>
                {board.nodes.length} blocks · {board.connections.length}{" "}
                connections
              </span>
              <span>Drag to move · Scroll to zoom · Click a block to edit</span>
            </footer>
          </>
        )}
      </main>
    </Workspace>
  );
}
function WorkflowDetails({
  workflow,
  locked,
  onSaved,
  onBusy,
  onDirty,
  onClose,
}: {
  workflow: Workflow;
  locked: boolean;
  onSaved: (change: SavedCanvasChange) => void;
  onBusy: (saving: boolean) => void;
  onDirty: (v: boolean) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(workflow.name),
    [goal, setGoal] = useState(workflow.desired_outcome),
    [revision, setRevision] = useState(workflow.revision),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState<Workflow | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    onBusy(true);
    setError("");
    try {
      const w = await api<Workflow>(`/api/workflows/${workflow.id}`, "PATCH", {
        name,
        desired_outcome: goal,
        expected_revision: revision,
      });
      setRevision(w.revision);
      onDirty(false);
      onSaved({ workflow: w });
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === "STALE_EDIT")
        setConflict((e.details as { current: Workflow }).current);
    } finally {
      setSaving(false);
      onBusy(false);
    }
  }
  return (
    <aside className="inspector" aria-label="Workflow details">
      <div className="panel-heading">
        Workflow details
        <button
          className="icon-button"
          aria-label="Close details"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      {error && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
      {conflict && (
        <div className="conflict-box">
          <p>Saved name: {conflict.name}</p>
          <p>Saved outcome: {conflict.desired_outcome}</p>
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
          <label>
            Workflow name
            <input
              required
              maxLength={200}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                onDirty(true);
              }}
            />
          </label>
          <label>
            What should this workflow accomplish?
            <textarea
              value={goal}
              rows={7}
              maxLength={10000}
              onChange={(e) => {
                setGoal(e.target.value);
                onDirty(true);
              }}
              placeholder="Describe the result that matters to you."
            />
          </label>
          <button className="primary full-width" disabled={!!conflict}>
            {saving ? "Saving…" : "Save workflow details"}
          </button>
        </fieldset>
      </form>
    </aside>
  );
}
