"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  type Node,
  type NodeProps,
  type OnNodesChange,
  type Connection as FlowConnection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  type Board,
  type CanvasNode,
  type NodeType,
  nodeTypes as primitiveTypes,
  nodeLabels,
} from "@/domain/canvas";
import { primitives } from "./primitives";
type ProcessNode = Node<
  {
    block: CanvasNode;
    findingCount: number;
    reviewHighlighted: boolean;
    onOpenReviews: () => void;
  },
  "process"
>;
function ProcessBlock({ data, selected }: NodeProps<ProcessNode>) {
  const n = data.block,
    Icon = primitives[n.type].icon;
  return (
    <div
      className={`process-block ${n.type}${selected ? " selected" : ""}${data.reviewHighlighted ? " review-highlighted" : ""}`}
    >
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
      {data.findingCount > 0 && (
        <button
          className="finding-badge nodrag"
          onClick={(e) => {
            e.stopPropagation();
            data.onOpenReviews();
          }}
          aria-label={`${data.findingCount} review findings on ${n.title}`}
        >
          {data.findingCount} to review
        </button>
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
  reviewHighlight?: {
    nodeIds: string[];
    connectionIds: string[];
    wholeWorkflow: boolean;
  };
  findingCounts?: Record<string, number>;
  onOpenReviews?: () => void;
  locked: boolean;
  onSelect: (kind: "node" | "connection", id: string) => void;
  onConnect: (c: FlowConnection) => void;
  onMove: (n: CanvasNode, x: number, y: number) => void;
  onAdd: (type: NodeType, position: { x: number; y: number }) => void;
}
function FlowCanvas({
  board,
  selected,
  findingCounts,
  reviewHighlight,
  onOpenReviews,
  locked,
  onSelect,
  onConnect,
  onMove,
  onAdd,
}: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const { fitView, screenToFlowPosition } = useReactFlow();
  useEffect(() => {
    if (!frame.current) return;
    let animationFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        void fitView({ padding: 0.25, maxZoom: 1 });
      });
    });
    observer.observe(frame.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(animationFrame);
    };
  }, [fitView]);
  const [positions, setPositions] = useState<
    Record<string, { revision: number; position: { x: number; y: number } }>
  >({});
  // React Flow's controlled nodes must retain measured dimensions across board
  // refreshes. These are browser layout state, not persisted process attributes.
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const nodes = useMemo(
    () =>
      board.nodes.map((n) => ({
        id: n.id,
        type: "process" as const,
        measured: measurements[n.id],
        position:
          positions[n.id]?.revision === n.revision
            ? positions[n.id].position
            : { x: n.x, y: n.y },
        data: {
          block: n,
          reviewHighlighted: !!(
            reviewHighlight?.wholeWorkflow ||
            reviewHighlight?.nodeIds.includes(n.id)
          ),
          findingCount: findingCounts?.[n.id] || 0,
          onOpenReviews: onOpenReviews || (() => {}),
        },
        selected: n.id === selected,
      })),
    [
      board.nodes,
      positions,
      measurements,
      selected,
      findingCounts,
      reviewHighlight,
      onOpenReviews,
    ],
  );
  const onNodesChange: OnNodesChange<ProcessNode> = (changes) => {
    const dimensions = changes.filter((c) => c.type === "dimensions");
    if (dimensions.length)
      setMeasurements((current) => {
        let next = current;
        for (const c of dimensions) {
          if (
            c.dimensions &&
            (current[c.id]?.width !== c.dimensions.width ||
              current[c.id]?.height !== c.dimensions.height)
          )
            next = { ...next, [c.id]: c.dimensions };
        }
        return next;
      });
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
    <div ref={frame} style={{ width: "100%", height: "100%" }}>
      <ReactFlow<ProcessNode>
        nodes={nodes}
        edges={board.connections.map((c) => ({
          id: c.id,
          source: c.source_node_id,
          target: c.target_node_id,
          label: c.is_default ? "Otherwise" : c.condition_text,
          selected: c.id === selected,
          className:
            reviewHighlight?.wholeWorkflow ||
            reviewHighlight?.connectionIds.includes(c.id)
              ? "review-highlighted"
              : undefined,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color:
              reviewHighlight?.wholeWorkflow ||
              reviewHighlight?.connectionIds.includes(c.id)
                ? "var(--blue)"
                : undefined,
          },
          style: {
            strokeWidth:
              reviewHighlight?.wholeWorkflow ||
              reviewHighlight?.connectionIds.includes(c.id)
                ? 3
                : 1.6,
          },
          labelStyle: { fontSize: 11 },
          labelBgPadding: [6, 4] as [number, number],
        }))}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onDragOver={(event) => {
          if (
            locked ||
            !event.dataTransfer.types.includes("application/meridian-block")
          )
            return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          event.preventDefault();
          const type = event.dataTransfer.getData("application/meridian-block");
          if (locked || !primitiveTypes.includes(type as NodeType)) return;
          const position = screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          });
          onAdd(type as NodeType, { x: position.x - 105, y: position.y - 25 });
        }}
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
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.5}
        defaultViewport={{ x: 80, y: 60, zoom: 1 }}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={22} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
export function ProcessCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <FlowCanvas {...props} />
    </ReactFlowProvider>
  );
}
