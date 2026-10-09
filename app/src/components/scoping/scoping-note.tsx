"use client";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { StickyNote, X, Expand, Minimize2, GripHorizontal } from "lucide-react";
import type { Board } from "@/domain/canvas";
import { useScoping } from "./use-scoping";
import { ScopingContent } from "./scoping-content";
export function ScopingNote({
  board,
  onApplied,
  onReview,
}: {
  board: Board;
  onApplied: (b: Board) => void;
  onReview: () => void;
}) {
  const c = useScoping(board.workflow.id, board.workflow.state !== "draft");
  const [open, setOpen] = useState(false),
    [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  const dialog = useRef<HTMLDialogElement>(null),
    toggle = useRef<HTMLButtonElement>(null);
  const positionKey = `meridian-scoping-position:${board.workflow.id}`;
  const clamp = (p: { x: number; y: number }) => ({
    x: Math.max(
      12,
      Math.min(
        p.x,
        window.innerWidth - Math.min(520, window.innerWidth - 24) - 12,
      ),
    ),
    y: Math.max(
      12,
      Math.min(
        p.y,
        window.innerHeight - Math.min(650, window.innerHeight - 24) - 12,
      ),
    ),
  });
  const savePosition = (p: { x: number; y: number }) => {
    const next = clamp(p);
    setPosition(next);
    try {
      localStorage.setItem(positionKey, JSON.stringify(next));
    } catch {}
  };
  const close = () => {
    void c.flush().catch(() => {});
    setOpen(false);
    toggle.current?.focus();
  };
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const focused = document.activeElement as HTMLElement | null;
    if (d.open) d.close();
    if (open) {
      if (expanded) d.showModal();
      else d.show();
      if (focused && d.contains(focused))
        focused.focus({ preventScroll: true });
    }
  }, [open, expanded]);
  useEffect(() => {
    const resize = () => setPosition((p) => (p ? clamp(p) : p));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  function startDrag(e: PointerEvent<HTMLButtonElement>) {
    if (expanded || !dialog.current) return;
    const r = dialog.current.getBoundingClientRect();
    drag.current = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function show() {
    if (open) {
      close();
      return;
    }
    let p: { x: number; y: number } | null = null;
    try {
      const stored = JSON.parse(localStorage.getItem(positionKey) || "null");
      if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y))
        p = stored;
    } catch {}
    const rect = toggle.current!.getBoundingClientRect();
    setPosition(
      clamp(
        p || { x: rect.left + 58, y: Math.max(90, window.innerHeight - 690) },
      ),
    );
    if (window.innerWidth < 760) setExpanded(true);
    setOpen(true);
    void c.refresh().catch(() => {});
  }
  return (
    <>
      <button
        ref={toggle}
        className={`scoping-toggle ${open ? "is-open" : ""}`}
        title={open ? "Hide process note" : "Open process note"}
        aria-label={open ? "Hide process note" : "Open process note"}
        aria-expanded={open}
        aria-controls="scoping-window"
        onClick={show}
      >
        <StickyNote className="note-icon" size={20} />
        <X className="close-icon" size={20} />
      </button>
      {c.state?.needs_review && board.workflow.state === "draft" && (
        <button className="scoping-review-reminder" onClick={onReview}>
          Not reviewed · Review draft
        </button>
      )}
      <dialog
        ref={dialog}
        id="scoping-window"
        aria-labelledby="scoping-window-title"
        className={`scoping-window ${expanded ? "is-expanded" : ""}`}
        style={
          !expanded && position
            ? { left: position.x, top: position.y }
            : undefined
        }
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            e.preventDefault();
            close();
          }
        }}
      >
        <header className="scoping-window-header">
          <div>
            <span className="eyebrow">Process scratchpad</span>
            <h2 id="scoping-window-title">From thoughts to workflow</h2>
          </div>
          <div className="button-row">
            {!expanded && (
              <button
                className="icon-button scoping-drag"
                aria-label="Move process note"
                title="Drag to move, or use arrow keys"
                onPointerDown={startDrag}
                onPointerMove={(e) => {
                  if (drag.current)
                    savePosition({
                      x: drag.current.left + e.clientX - drag.current.x,
                      y: drag.current.top + e.clientY - drag.current.y,
                    });
                }}
                onPointerUp={() => {
                  drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                onKeyDown={(e) => {
                  const delta = {
                    ArrowLeft: [-20, 0],
                    ArrowRight: [20, 0],
                    ArrowUp: [0, -20],
                    ArrowDown: [0, 20],
                  }[e.key];
                  if (delta && position) {
                    e.preventDefault();
                    savePosition({
                      x: position.x + delta[0],
                      y: position.y + delta[1],
                    });
                  }
                }}
              >
                <GripHorizontal size={18} />
              </button>
            )}
            <button
              className="icon-button"
              aria-label={
                expanded ? "Restore floating note" : "Expand process note"
              }
              title={expanded ? "Restore floating note" : "Expand process note"}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Minimize2 size={18} /> : <Expand size={18} />}
            </button>
            <button
              className="icon-button"
              aria-label="Close process note"
              onClick={close}
            >
              <X size={18} />
            </button>
          </div>
        </header>
        <ScopingContent
          controller={c}
          board={board}
          onApplied={onApplied}
          onReview={() => {
            close();
            onReview();
          }}
          expanded={expanded}
        />
      </dialog>
    </>
  );
}
