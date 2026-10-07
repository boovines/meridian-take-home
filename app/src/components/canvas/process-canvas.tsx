"use client";
import { useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type NodeProps,
  type OnNodesChange,
  type Connection as FlowConnection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type Board, type CanvasNode, nodeLabels } from "@/domain/canvas";
import { primitives } from "./primitives";
type ProcessNode = Node<{ block: CanvasNode }, "process">;
function ProcessBlock({ data, selected }: NodeProps<ProcessNode>) {
  const n = data.block,
    Icon = primitives[n.type].icon;
  return (
    <div className={`process-block ${n.type}${selected ? " selected" : ""}`}>
      <Handle
        type="target"
        position={Position.Top}
        aria-label="Incoming connection"
      />
      <div className="block-kind">
        <Icon size={14} />
        <span>{nodeLabels[n.type]}</span>
      </div>
      <strong>
        {n.title || `Untitled ${nodeLabels[n.type].toLowerCase()}`}
      </strong>
      <p>{n.instructions || "Add instructions"}</p>
      {(n.split_mode || n.join_for_split_id) && (
        <div className="block-routing">
          {n.split_mode === "parallel"
            ? "Run both paths"
            : n.split_mode === "exclusive"
              ? "Choose one path"
              : "Wait for both paths"}
        </div>
      )}
      <Handle
        type="source"
        position={Position.Bottom}
        aria-label="Outgoing connection"
      />
    </div>
  );
}
const nodeTypes = { process: ProcessBlock };
interface Props {
  board: Board;
  selected?: string;
  locked: boolean;
  onSelect: (kind: "node" | "connection", id: string) => void;
  onConnect: (c: FlowConnection) => void;
  onMove: (n: CanvasNode, x: number, y: number) => void;
}
function FlowCanvas({
  board,
  selected,
  locked,
  onSelect,
  onConnect,
  onMove,
}: Props) {
  const [positions, setPositions] = useState<
    Record<string, { revision: number; position: { x: number; y: number } }>
  >({});
  const nodes = useMemo(
    () =>
      board.nodes.map((n) => ({
        id: n.id,
        type: "process" as const,
        position:
          positions[n.id]?.revision === n.revision
            ? positions[n.id].position
            : { x: n.x, y: n.y },
        data: { block: n },
        selected: n.id === selected,
      })),
    [board.nodes, positions, selected],
  );
  const onNodesChange: OnNodesChange<ProcessNode> = (changes) => {
    const updates = changes.filter((c) => c.type === "position");
    if (updates.length)
      setPositions((current) => {
        const next = { ...current };
        for (const c of updates) {
          const n = board.nodes.find((n) => n.id === c.id);
          if (n && c.position)
            next[c.id] = { revision: n.revision, position: c.position };
        }
        return next;
      });
  };
  return (
    <ReactFlow<ProcessNode>
      nodes={nodes}
      edges={board.connections.map((c) => ({
        id: c.id,
        source: c.source_node_id,
        target: c.target_node_id,
        label: c.is_default ? "Otherwise" : c.condition_text,
        selected: c.id === selected,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 1.6 },
        labelStyle: { fontSize: 11 },
        labelBgPadding: [6, 4] as [number, number],
      }))}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_, n) => onSelect("node", n.id)}
      onEdgeClick={(_, e) => onSelect("connection", e.id)}
      onConnect={onConnect}
      onNodeDragStop={(_, n) =>
        onMove(n.data.block, n.position.x, n.position.y)
      }
      nodesDraggable={!locked}
      nodesConnectable={!locked}
      deleteKeyCode={null}
      fitView
      minZoom={0.25}
      maxZoom={1.5}
      defaultViewport={{ x: 80, y: 60, zoom: 1 }}
      proOptions={{ hideAttribution: false }}
    >
      <Background gap={22} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
export function ProcessCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <FlowCanvas {...props} />
    </ReactFlowProvider>
  );
}
