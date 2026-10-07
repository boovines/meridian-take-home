"use client";
import type { CanvasNode } from "@/domain/canvas";
import type { PlanStep, Method } from "@/domain/engineering";
export interface PlanChoicesProps {
  nodes: CanvasNode[];
  steps: PlanStep[];
  disabled: boolean;
  onChange: (
    step: PlanStep,
    change: { selected_method?: Method; approved?: boolean },
  ) => void;
}
export function MethodControls({
  node,
  step,
  disabled,
  onChange,
}: {
  node: CanvasNode;
  step: PlanStep;
  disabled: boolean;
  onChange: PlanChoicesProps["onChange"];
}) {
  const required = ["human_handoff", "human_approval"].includes(node.type);
  return (
    <div className="method-controls">
      <select
        aria-label={`Method for ${node.title}`}
        value={step.selected_method}
        disabled={disabled || required}
        onChange={(e) =>
          onChange(step, { selected_method: e.target.value as Method })
        }
      >
        <option value="code">Code</option>
        <option value="agent">Agent</option>
        <option value="human">Human</option>
      </select>
      <label className="approval-check">
        <input
          type="checkbox"
          aria-label={`Approve ${node.title}`}
          checked={!!step.approved_at}
          disabled={disabled}
          onChange={(e) => onChange(step, { approved: e.target.checked })}
        />{" "}
        Approved
      </label>
      {required && <small>Required human step</small>}
    </div>
  );
}
export function Recommendation({ step }: { step: PlanStep }) {
  return (
    <p className="recommendation">
      {step.recommended_method ? (
        <>
          <strong>AI suggests {step.recommended_method}.</strong>{" "}
          {step.recommendation_reason}
        </>
      ) : (
        "No AI recommendation yet. Choose a method or request suggestions."
      )}
    </p>
  );
}
