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
type Props = { workflowId: string; stepId?: string; caseResultId?: string };
export function AuditTrail(props: Props) {
  return (
    <InvocationAudit
      key={`${props.workflowId}:${props.stepId || props.caseResultId}`}
      {...props}
    />
  );
}
function InvocationAudit({ workflowId, stepId, caseResultId }: Props) {
  const [opened, setOpened] = useState(false),
    [reload, setReload] = useState(0);
  const [events, setEvents] = useState<AuditEvent[] | null>(null),
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
        if (active) {
          setEvents(r.events);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [workflowId, stepId, caseResultId, opened, reload]);
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
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            onClick={() => {
              setError("");
              setReload((n) => n + 1);
            }}
          >
            Retry loading audit
          </button>
        </div>
      )}
      {!events ? (
        !error && <p role="status">Loading audit…</p>
      ) : events.length === 0 ? (
        <p>No audit events recorded for this invocation.</p>
      ) : (
        events.map((event) => (
          <EventDetails key={event.id} workflowId={workflowId} event={event} />
        ))
      )}
    </details>
  );
}
// Each disclosure owns its request. Opening another event must not cancel an
// earlier event's pending read or leave it permanently blank.
function EventDetails({
  workflowId,
  event,
}: {
  workflowId: string;
  event: AuditEvent;
}) {
  const [opened, setOpened] = useState(false),
    [reload, setReload] = useState(0),
    [result, setResult] = useState<{ payload: unknown } | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (!opened) return;
    let active = true;
    api<{ payload: unknown }>(
      `/api/workflows/${workflowId}/audit-events/${event.id}`,
    )
      .then((r) => {
        if (active) {
          setResult(r);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [workflowId, event.id, opened, reload]);
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open) setOpened(true);
      }}
    >
      <summary>
        {labels[event.kind]} · {event.summary.elapsed_ms} ms
        {event.summary.model ? ` · ${event.summary.model}` : ""}
      </summary>
      <p className="field-help">
        Attempt {event.attempt_token.slice(0, 8)} · event {event.sequence}
      </p>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button
            onClick={() => {
              setError("");
              setReload((n) => n + 1);
            }}
          >
            Retry loading event details
          </button>
        </div>
      ) : result ? (
        <pre tabIndex={0}>{JSON.stringify(result.payload, null, 2)}</pre>
      ) : (
        <p role="status">Loading event details…</p>
      )}
    </details>
  );
}
