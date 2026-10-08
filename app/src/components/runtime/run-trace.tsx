"use client";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { RunRecord, StepRecord, HumanRequest } from "@/domain/runtime";
import "./runtime.css";
import { AuditTrail } from "./audit-trail";
export interface RunState {
  runs: RunRecord[];
  steps: StepRecord[];
  human_requests: HumanRequest[];
}
export function RunTrace({
  workflowId,
  runId,
  nodeTitles,
}: {
  workflowId: string;
  runId: string;
  nodeTitles: Record<string, string>;
}) {
  const [state, setState] = useState<RunState | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<RunState>(`/api/workflows/${workflowId}/runs/${runId}`)
      .then((s) => {
        if (active) setState(s);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [workflowId, runId]);
  if (error) return <p role="alert">{error}</p>;
  if (!state) return <p role="status">Loading step trace…</p>;
  return (
    <div className="run-trace">
      <p className="field-help">
        Run {state.runs[0].status.replaceAll("_", " ")} · {state.steps.length}{" "}
        visits · {Math.round(state.runs[0].active_elapsed_ms / 1000)} active
        seconds
      </p>
      {state.steps.map((s) => (
        <details key={s.id}>
          <summary>
            {s.occurrence_number}. {nodeTitles[s.node_id] || s.node_id} · visit{" "}
            {s.node_visit_number} · {s.status.replaceAll("_", " ")}
          </summary>
          {s.failure_message && (
            <p className="error-banner">{s.failure_message}</p>
          )}
          <h4>Inputs from earlier visits</h4>
          {Object.keys(s.input_step_refs).length ? (
            Object.entries(s.input_step_refs).map(([node, id]) => (
              <div key={node}>
                <strong>{nodeTitles[node] || node}</strong>
                <pre tabIndex={0}>
                  {JSON.stringify(
                    state.steps.find((p) => p.id === id)?.output_data,
                    null,
                    2,
                  )}
                </pre>
              </div>
            ))
          ) : (
            <p>Uses the captured input bundle.</p>
          )}
          <h4>Output</h4>
          <pre tabIndex={0}>{JSON.stringify(s.output_data, null, 2)}</pre>
          <AuditTrail workflowId={workflowId} stepId={s.id} />
          {state.human_requests
            .filter((h) => h.step_execution_id === s.id)
            .map((h) => (
              <div key={h.id}>
                <h4>Human response · {h.response_source || h.status}</h4>
                <pre tabIndex={0}>{JSON.stringify(h.response, null, 2)}</pre>
              </div>
            ))}
        </details>
      ))}
    </div>
  );
}
