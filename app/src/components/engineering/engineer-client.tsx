"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import Workspace from "../shell/workspace";
import { api, errorMessage } from "@/lib/api";
import type { EngineeringState } from "./types";
import { ImplementationPanel } from "./implementation-panel";
import { AgentPanel } from "./agent-panel";
import "./engineer.css";
export function EngineerClient({ id }: { id: string }) {
  const [state, setState] = useState<EngineeringState | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [action, setAction] = useState(""),
    [tab, setTab] = useState("Implementation"),
    [selectedPlan, setSelectedPlan] = useState("");
  const load = useCallback(
    async () =>
      setState(await api<EngineeringState>(`/api/workflows/${id}/engineering`)),
    [id],
  );
  useEffect(() => {
    let active = true;
    api<EngineeringState>(`/api/workflows/${id}/engineering`)
      .then((s) => {
        if (active) setState(s);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [id]);
  const activeJob = state?.jobs.find((j) =>
    ["queued", "running", "waiting_for_human", "cancel_requested"].includes(
      j.status,
    ),
  );
  const activeJobId = activeJob?.id;
  useEffect(() => {
    if (!activeJobId) return;
    const timer = setInterval(() => {
      void load().catch((e) => setError(errorMessage(e)));
    }, 2500);
    return () => clearInterval(timer);
  }, [activeJobId, load]);
  async function mutate(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setAction(label);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorMessage(e));
      await load().catch(() => {});
    } finally {
      setBusy(false);
      setAction("");
    }
  }
  const base = `/api/workflows/${id}`;
  return (
    <Workspace
      title={state?.workflow.name || "Engineer workspace"}
      subtitle="Customer scope is frozen. Choose the implementation, inspect the code, and verify the result."
      actions={
        <Link className="button-link" href={`/workflows/${id}`}>
          View frozen whiteboard
        </Link>
      }
    >
      <main className="engineer-workspace">
        <div className="engineer-topline">
          <span className="status-pill">Frozen spec v1</span>
          <span className="field-help">{state?.workflow.desired_outcome}</span>
        </div>
        <nav className="engineer-tabs" aria-label="Engineer workspace">
          {["Implementation", "Agent", "Evaluation"].map((t) => (
            <button
              key={t}
              aria-current={tab === t ? "page" : undefined}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
        {error && (
          <div role="alert" className="error-banner">
            {error}
            <button
              onClick={() =>
                void load()
                  .then(() => setError(""))
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              Reload
            </button>
          </div>
        )}
        {activeJob && (
          <div className="operation-banner" role="status">
            <div>
              <strong>
                {activeJob.kind === "generation"
                  ? "Generating agent"
                  : "Working"}{" "}
                · {activeJob.phase.replaceAll("_", " ")}
              </strong>
              <p>
                {activeJob.phase === "queued"
                  ? "Waiting for the worker. You can leave this page and return."
                  : activeJob.phase === "generating"
                    ? "Writing the step implementations. Your existing versions remain available."
                    : activeJob.phase === "validating"
                      ? "Checking generated JavaScript in an isolated sandbox."
                      : "Saving progress. You can continue inspecting the workspace."}
              </p>
            </div>
            <button
              disabled={busy || activeJob.status === "cancel_requested"}
              onClick={() =>
                void mutate("Requesting cancellation…", () =>
                  api(`${base}/jobs/${activeJob.id}/cancel`, "POST", {}),
                )
              }
            >
              {activeJob.status === "cancel_requested"
                ? "Stopping…"
                : "Cancel operation"}
            </button>
          </div>
        )}
        {state?.jobs[0]?.status === "failed" && (
          <div role="alert" className="error-banner">
            {state.jobs[0].error_message}
          </div>
        )}
        {busy && (
          <p role="status" className="field-help">
            {action}
          </p>
        )}
        {!state ? (
          <p role="status">
            {error
              ? "Unable to open engineer workspace."
              : "Loading frozen workflow…"}
          </p>
        ) : tab === "Implementation" ? (
          <ImplementationPanel
            state={state}
            selectedPlan={selectedPlan}
            setSelectedPlan={setSelectedPlan}
            busy={busy}
            operationActive={!!activeJob}
            mutate={mutate}
            onGenerated={() => setTab("Agent")}
          />
        ) : tab === "Agent" ? (
          <AgentPanel
            workflowId={id}
            versions={state.versions}
            jobs={state.jobs}
            nodeTitles={Object.fromEntries(
              state.spec.board.nodes.map((n) => [n.id, n.title]),
            )}
            generating={activeJob?.kind === "generation"}
          />
        ) : (
          <div className="engineer-empty">
            <span className="eyebrow">Trusted evaluation</span>
            <h2>Generated code still needs evidence.</h2>
            <p>
              Evaluation will compare a selected code version with a verified,
              locked suite. Syntax validation alone does not establish
              correctness.
            </p>
            <p className="field-help">
              Evaluation and repair are the next implementation milestone.
            </p>
          </div>
        )}
        {!!state?.jobs.length && (
          <details className="operation-history">
            <summary>Operation history · {state.jobs.length}</summary>
            {state.jobs.map((j) => (
              <div key={j.id}>
                <strong>
                  {j.kind} · {j.status}
                </strong>
                <span>{new Date(j.created_at).toLocaleString()}</span>
                {j.error_message && <p>{j.error_message}</p>}
              </div>
            ))}
          </details>
        )}
      </main>
    </Workspace>
  );
}
