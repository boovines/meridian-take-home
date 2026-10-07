"use client";
import {
  MethodControls,
  Recommendation,
  type PlanChoicesProps,
} from "./plan-controls";
export default function PlanChoices({
  nodes,
  steps,
  disabled,
  onChange,
}: PlanChoicesProps) {
  return (
    <div className="plan-table">
      <div className="plan-table-heading">
        <span>Frozen step</span>
        <span>Implementation & approval</span>
      </div>
      {nodes.map((node, i) => {
        const step = steps.find((s) => s.node_id === node.id)!;
        return (
          <article className="plan-row" key={node.id}>
            <div>
              <span className="step-number">
                {String(i + 1).padStart(2, "0")}
              </span>
              <strong>{node.title}</strong>
              <details>
                <summary>Requirements</summary>
                <p className="node-requirements">
                  {node.instructions || "No additional instructions."}
                </p>
              </details>
              <Recommendation step={step} />
            </div>
            <MethodControls
              node={node}
              step={step}
              disabled={disabled}
              onChange={onChange}
            />
          </article>
        );
      })}
    </div>
  );
}
