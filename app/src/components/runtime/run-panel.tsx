"use client";
import { useCallback, useEffect, useState, useRef } from "react";
import { api, errorMessage } from "@/lib/api";
import type { EngineeringState } from "../engineering/types";
import type { HumanResponse, RunRecord } from "@/domain/runtime";
import { RunTrace, type RunState } from "./run-trace";
import { GmailPicker } from "./gmail-picker";
import { HumanResponseForm } from "./human-response";
import { RunResult } from "./run-result";
import { RunWorkbench } from "./run-workbench";
import "./run-panel.css";
interface Bundle {
  id: string;
  source_kind: string;
  shipment_reference: string | null;
  created_at: string;
}
const activeStatuses = ["queued", "running", "waiting_for_human"];
export function RunPanel({
  state,
  operationActive,
  onOperationStarted,
}: {
  state: EngineeringState;
  operationActive: boolean;
  onOperationStarted: () => Promise<void>;
}) {
  const refreshSequence = useRef(0);
  const base = `/api/workflows/${state.workflow.id}`;
  const [bundles, setBundles] = useState<Bundle[]>([]),
    [bundleId, setBundleId] = useState(""),
    [versionId, setVersionId] = useState(state.versions[0]?.id || ""),
    [history, setHistory] = useState<RunRecord[]>([]),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<RunState | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const loadBundles = useCallback(async () => {
    const rows = await api<Bundle[]>(`${base}/input-bundles`);
    setBundles(rows);
    return rows;
  }, [base]);
  const readState = useCallback(
    async (id?: string) => {
      const sequence = ++refreshSequence.current;
      const list = await api<RunState>(`${base}/runs?kind=manual`);
      const chosen = id || selected || list.runs[0]?.id;
      const next = chosen
        ? list.runs[0]?.id === chosen
          ? list
          : await api<RunState>(`${base}/runs/${chosen}`)
        : null;
      return { sequence, list, chosen, next };
    },
    [base, selected],
  );
  const publishState = useCallback(
    (value: Awaited<ReturnType<typeof readState>>) => {
      if (value.sequence !== refreshSequence.current) return;
      setHistory(value.list.runs);
      setDetail(value.next);
      if (value.chosen) setSelected(value.chosen);
    },
    [],
  );
  const refresh = useCallback(
    async (id?: string) => publishState(await readState(id)),
    [readState, publishState],
  );
  useEffect(() => {
    let active = true;
    void api<Bundle[]>(`${base}/input-bundles`)
      .then((rows) => {
        if (active) {
          setBundles(rows);
          setBundleId((id) => id || rows[0]?.id || "");
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [base]);
  useEffect(() => {
    let active = true;
    void readState()
      .then((value) => {
        if (active) publishState(value);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [readState, publishState]);
  const run = detail?.runs[0];
  const polling =
    operationActive || (!!run && activeStatuses.includes(run.status));
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      void refresh().catch((e) => setError(errorMessage(e)));
    }, 2000);
    return () => clearInterval(timer);
  }, [polling, refresh]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function start(retry?: RunRecord) {
    const result = await api<{ run: RunRecord }>(`${base}/runs`, "POST", {
      request_key: crypto.randomUUID(),
      implementation_version_id: retry?.implementation_version_id || versionId,
      input_bundle_id: retry?.input_bundle_id || bundleId,
      rerun_of_id: retry?.id || null,
    });
    await refresh(result.run.id);
    await onOperationStarted();
  }
  async function answer(id: string, response: HumanResponse) {
    await api(`${base}/human-requests/${id}/answer`, "POST", {
      request_key: crypto.randomUUID(),
      response,
    });
    setMessage("Response saved for this visit.");
    await refresh();
    await onOperationStarted();
  }
  const pending =
    detail?.human_requests.filter((h) => h.status === "pending") || [];
  const output = detail?.steps.find(
    (s) => s.id === run?.result_step_id,
  )?.output_data;
  const nodeTitles = Object.fromEntries(
    state.spec.board.nodes.map((n) => [n.id, n.title]),
  );
  const currentBundle = bundles.find((b) => b.id === run?.input_bundle_id);
  const versionNumber = state.versions.find(
    (v) => v.id === run?.implementation_version_id,
  )?.version_number;
  const setup = (
    <section className="run-setup" aria-label="Run setup">
      <span className="eyebrow">Choose input</span>
      <h3>Run this workflow</h3>
      <p className="field-help">
        Use a saved packet or capture existing Gmail messages. Reports are
        previewed only.
      </p>
      <label>
        Implementation to run
        <select
          value={versionId}
          onChange={(e) => setVersionId(e.target.value)}
          disabled={busy || operationActive}
        >
          <option value="" disabled>
            Select code
          </option>
          {state.versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.version_number} · {new Date(v.created_at).toLocaleString()}
            </option>
          ))}
        </select>
      </label>
      <label>
        Captured input
        <select
          value={bundleId}
          onChange={(e) => setBundleId(e.target.value)}
          disabled={busy || operationActive}
        >
          <option value="" disabled>
            Select a captured packet
          </option>
          {bundles.map((b) => (
            <option key={b.id} value={b.id}>
              {b.shipment_reference || "Unnamed input"} · {b.source_kind} ·{" "}
              {new Date(b.created_at).toLocaleString()}
            </option>
          ))}
        </select>
      </label>
      <button
        className="primary full-width"
        disabled={busy || operationActive || !bundleId || !versionId}
        onClick={() => void act(() => start())}
      >
        Start run
      </button>
      {operationActive && (
        <p className="field-help">
          Finish or cancel the active operation before starting another run.
        </p>
      )}
      {!bundles.length && (
        <p className="field-help">
          Capture an input packet to enable Start run.
        </p>
      )}
      <GmailPicker
        workflowId={state.workflow.id}
        disabled={busy || operationActive}
        onCaptured={async (id) => {
          await loadBundles();
          setBundleId(id);
          setMessage(
            "Packet captured. Choose its code version and start when ready.",
          );
        }}
      />
    </section>
  );
  const historyView = (
    <section className="run-history" aria-label="Run history">
      <h3>Recent runs</h3>
      {!history.length ? (
        <p className="field-help">Your manually started runs appear here.</p>
      ) : (
        history.map((r) => (
          <button
            key={r.id}
            aria-pressed={r.id === selected}
            onClick={() => {
              setError("");
              setMessage("");
              void refresh(r.id).catch((e) => setError(errorMessage(e)));
            }}
          >
            <span>
              <strong>
                {bundles.find((b) => b.id === r.input_bundle_id)
                  ?.shipment_reference || "Captured input"}
              </strong>
              <small>{new Date(r.created_at).toLocaleString()}</small>
            </span>
            <span>{r.status.replaceAll("_", " ")}</span>
          </button>
        ))
      )}
    </section>
  );
  const result = (
    <section className="run-inspection" aria-label="Run inspection">
      {!run ? (
        <div className="run-empty">
          <span className="eyebrow">Ready when you are</span>
          <h3>Follow the process as it runs</h3>
          <p>
            Each step keeps its inputs, output, and any errors. Human steps
            pause here for your response.
          </p>
        </div>
      ) : (
        <>
          <div className="run-heading">
            <div>
              <span className="eyebrow">{run.status.replaceAll("_", " ")}</span>
              <h3>{currentBundle?.shipment_reference || "Workflow run"}</h3>
              <p className="field-help">
                Code v{versionNumber || "?"} · {detail?.steps.length || 0} step
                visits · {new Date(run.created_at).toLocaleString()}
              </p>
            </div>
            {!activeStatuses.includes(run.status) && (
              <button
                disabled={busy || operationActive}
                onClick={() => void act(() => start(run))}
              >
                Retry same inputs
              </button>
            )}
          </div>
          {run.failure_message && (
            <p role="alert" className="inline-error">
              {run.failure_message}
            </p>
          )}
          {run.rerun_of_id && (
            <p className="field-help">
              New run linked to a previous attempt. The code and input packet
              are unchanged; human responses are requested again.
            </p>
          )}
          {pending.map((h) => (
            <HumanResponseForm
              key={h.id}
              request={h}
              disabled={
                busy ||
                state.jobs.some(
                  (j) => j.id === run.job_id && j.status === "cancel_requested",
                )
              }
              onAnswer={(response) => act(() => answer(h.id, response))}
            />
          ))}
          {run.status === "completed" && output !== undefined && (
            <RunResult output={output} />
          )}
          {run.status !== "completed" &&
            !pending.length &&
            activeStatuses.includes(run.status) && (
              <p role="status" className="field-help">
                {run.status === "queued"
                  ? "Waiting for the worker. It is safe to leave and return."
                  : "Processing this packet. Progress is saved as each step finishes."}
              </p>
            )}
          <details className="run-trace-disclosure">
            <summary>Step history · {detail?.steps.length || 0} visits</summary>
            <RunTrace
              key={`${run.id}-${detail?.steps.map((s) => s.status).join("-")}`}
              workflowId={state.workflow.id}
              runId={run.id}
              nodeTitles={nodeTitles}
            />
          </details>
          <p className="field-help run-limits">
            Limits: {run.limits.step_attempts} step attempts ·{" "}
            {run.limits.active_ms / 60000} active minutes. Human waiting time is
            excluded.
          </p>
        </>
      )}
    </section>
  );
  return (
    <div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
          <button
            onClick={() =>
              void act(async () => {
                await refresh();
                await loadBundles();
              })
            }
          >
            Refresh run
          </button>
        </div>
      )}
      {message && (
        <p role="status" className="run-notice">
          {message}
        </p>
      )}
      <RunWorkbench setup={setup} history={historyView} result={result} />
    </div>
  );
}
