"use client";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { AuditEvent } from "@/domain/execution-audit";
const labels = {
  initial_output: "Generated step output",
  model_request: "Model request and selected documents",
  model_response: "Model response before postprocessing",
  final_output: "Generated postprocessing output",
  failure: "Invocation failure",
};
export function AuditTrail({
  workflowId,
  stepId,
  caseResultId,
}: {
  workflowId: string;
  stepId?: string;
  caseResultId?: string;
}) {
  const [opened, setOpened] = useState(false), [reload, setReload] = useState(0);
  const [events, setEvents] = useState<AuditEvent[] | null>(null),
    [selected, setSelected] = useState(""),
    [payloads, setPayloads] = useState<Record<string, unknown>>({}),
    [error, setError] = useState("");
  useEffect(() => {
    if (!opened) return;
    let active = true;
    const query = new URLSearchParams(
      stepId
        ? { step_execution_id: stepId }
        : { case_result_id: caseResultId! },
    );
    api<{ events: AuditEvent[] }>(
      `/api/workflows/${workflowId}/audit-events?${query}`,
    )
      .then((r) => {
        if (active) setEvents(r.events);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [workflowId, stepId, caseResultId, opened]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    api<{ payload: unknown }>(
      `/api/workflows/${workflowId}/audit-events/${selected}`,
    )
      .then((r) => {
        if (active) setPayloads((old) => ({ ...old, [selected]: r.payload }));
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [workflowId, selected, reload]);
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary>Execution audit</summary>
      <p className="field-help">
        Recorded requests and responses, before the final step output. Older
        runs may not have this audit. A request without a response is incomplete
        evidence. Times are elapsed from invocation start.
      </p>
      {error && <p role="alert">{error}</p>}
      {!events ? (
        <p role="status">Loading audit…</p>
      ) : events.length === 0 ? (
        <p>No audit events recorded for this invocation.</p>
      ) : (
        events.map((e) => (
          <details
            key={e.id}
            onToggle={(event) => {
              if (event.currentTarget.open) setSelected(e.id);
            }}
          >
            <summary>
              {labels[e.kind]} · {e.summary.elapsed_ms} ms
              {e.summary.model ? ` · ${e.summary.model}` : ""}
            </summary>
            <p className="field-help">
              Attempt {e.attempt_token.slice(0, 8)} · event {e.sequence}
            </p>
            {Object.hasOwn(payloads, e.id) ? (
              <pre tabIndex={0}>{JSON.stringify(payloads[e.id], null, 2)}</pre>
            ) : (
              <button onClick={() => { setSelected(e.id); setReload(n => n + 1); }}>
                Load event details
              </button>
            )}
          </details>
        ))
      )}
    </details>
  );
}
