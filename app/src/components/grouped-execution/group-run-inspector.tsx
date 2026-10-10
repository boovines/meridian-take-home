"use client";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { GroupExecution } from "@/domain/grouped-execution";
import { HumanResponseForm } from "../runtime/human-response";
import { RunTrace, type RunState } from "../runtime/run-trace";
import { RecoveryPanel } from "../runtime/recovery-panel";
import { RunResult } from "../runtime/run-result";
export function GroupRunInspector({
  workflowId,
  execution,
  title,
  nodeTitles,
  parentActive,
  onUpdated,
  onInspectCode,
}: {
  workflowId: string;
  execution: GroupExecution;
  title: string;
  nodeTitles: Record<string, string>;
  parentActive: boolean;
  onUpdated: () => Promise<void>;
  onInspectCode: (id: string) => void;
}) {
  const [inspected, setInspected] = useState(""),
    [detail, setDetail] = useState<RunState | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const runId = inspected || execution.run.id;
  const base = `/api/workflows/${workflowId}`;
  useEffect(() => {
    let active = true;
    const load = () =>
      void api<RunState>(`${base}/runs/${runId}`)
        .then((value) => {
          if (active) {
            setDetail(value);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(errorMessage(e));
        });
    load();
    const timer = parentActive ? setInterval(load, 2000) : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [base, runId, parentActive, refresh]);
  async function mutate(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setRefresh((n) => n + 1);
      await onUpdated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const run = detail?.runs[0]?.id === runId ? detail.runs[0] : undefined;
  return (
    <section className="group-inspector" aria-label={`Inspect ${title}`}>
      <div className="group-section-heading">
        <div>
          <span className="eyebrow">Run details</span>
          <h3>{title}</h3>
        </div>
        <button
          onClick={() =>
            onInspectCode(
              run?.implementation_version_id ??
                execution.run.implementation_version_id,
            )
          }
        >
          Inspect code
        </button>
      </div>
      <p className="field-help">
        {!inspected || inspected === execution.run.id
          ? `Code v${execution.version_number}`
          : "Earlier run"}{" "}
        ·{" "}
        {execution.completed
          ? "Execution complete · business results unverified"
          : execution.active_job.phase.replaceAll("_", " ")}
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {!run ? (
        <p role="status">Loading saved progress…</p>
      ) : (
        <>
          {detail?.recovery && (
            <RecoveryPanel
              promotesManualDefault={false}
              run={run}
              recovery={detail?.recovery ?? null}
              busy={busy || !parentActive}
              operationActive={true}
              nodeTitles={nodeTitles}
              onInspectCode={onInspectCode}
              onInspectRun={setInspected}
              onRecover={() => {}}
              onCancel={(id) =>
                void mutate(() => api(`${base}/jobs/${id}/cancel`, "POST", {}))
              }
              onAnswered={async () => {
                setRefresh((n) => n + 1);
                await onUpdated();
              }}
            />
          )}
          {run.failure_message && (
            <p className="inline-error" role="alert">
              {run.failure_message}
            </p>
          )}
          {detail?.human_requests
            .filter((h) => h.status === "pending")
            .map((h) => (
              <HumanResponseForm
                key={h.id}
                request={h}
                disabled={busy || !parentActive}
                onAnswer={(response) =>
                  mutate(() =>
                    api(`${base}/human-requests/${h.id}/answer`, "POST", {
                      request_key: crypto.randomUUID(),
                      response,
                    }),
                  )
                }
              />
            ))}
          {run.status === "completed" && (
            <RunResult workflowId={workflowId} runId={run.id}
              output={
                detail?.steps.find((s) => s.id === run.result_step_id)
                  ?.output_data ?? null
              }
            />
          )}
          <details className="run-trace-disclosure">
            <summary>
              Step history and audit · {detail?.steps.length ?? 0} visits
            </summary>
            <RunTrace
              key={`${runId}-${detail?.steps.map((s) => s.status).join("-")}`}
              workflowId={workflowId}
              runId={runId}
              nodeTitles={nodeTitles}
            />
          </details>
        </>
      )}
    </section>
  );
}
