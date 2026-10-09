"use client";
import { useMemo, useState } from "react";
import type { Workflow } from "@/domain/canvas";
import { nodeLabels } from "@/domain/canvas";
import { scaffoldBoard, type Scaffold, type Scope } from "@/domain/scoping";
import { ProcessCanvas } from "../canvas/process-canvas";
export function ScaffoldPreview({
  graph,
  scope,
  workflow,
}: {
  graph: Scaffold;
  scope: Scope;
  workflow: Workflow;
}) {
  const board = useMemo(
    () => scaffoldBoard(graph, workflow, scope),
    [graph, workflow, scope],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const node = board.nodes.find((n) => n.id === selected);
  const edge = board.connections.find((c) => c.id === selected);
  return (
    <div className="scaffold-preview">
      <p className="scoping-outcome">
        <strong>Desired outcome</strong>
        {graph.desired_outcome}
      </p>
      <div className="scaffold-graph" aria-label="Workflow preview graph">
        <ProcessCanvas
          board={board}
          locked
          selected={selected || undefined}
          onSelect={(_, id) => setSelected(id)}
          onConnect={() => {}}
          onMove={() => {}}
          onAdd={() => {}}
        />
      </div>
      <p className="field-help">
        Select a block or path to read its full instructions. This preview has
        not changed your board.
      </p>
      <label>
        Inspect a block
        <select
          value={node?.id || ""}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Choose a block</option>
          {board.nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.title}
            </option>
          ))}
        </select>
      </label>
      {node && (
        <div className="scoping-detail">
          <span className="eyebrow">{nodeLabels[node.type]}</span>
          <h3>{node.title}</h3>
          <p>{node.instructions}</p>
          {node.split_mode && (
            <small>
              {node.split_mode === "parallel"
                ? "Run both paths"
                : "Choose one path"}
            </small>
          )}
        </div>
      )}
      {edge && (
        <div className="scoping-detail">
          <strong>Path condition</strong>
          <p>
            {edge.is_default
              ? "Otherwise"
              : edge.condition_text || "Continue unconditionally"}
          </p>
        </div>
      )}
    </div>
  );
}
