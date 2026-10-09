"use client";
import { useState } from "react";
import { FileText } from "lucide-react";
import { ProcessContextPanel } from "./process-context-panel";

export function ProcessContextButton({
  workflowId,
  locked,
  onOpen,
  onSaved,
}: {
  workflowId: string;
  locked: boolean;
  onOpen: () => boolean;
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => {
          if (onOpen()) setOpen(true);
        }}
        aria-haspopup="dialog"
      >
        <FileText size={14} /> Process context{" "}
        <span className="context-optional">Optional</span>
      </button>
      {open && (
        <ProcessContextPanel
          workflowId={workflowId}
          locked={locked}
          onClose={() => setOpen(false)}
          onSaved={onSaved}
        />
      )}
    </>
  );
}
