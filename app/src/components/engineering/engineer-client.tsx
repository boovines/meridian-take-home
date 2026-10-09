"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorNotice } from "../error-notice";
import Workspace from "../shell/workspace";
import { api, errorMessage } from "@/lib/api";
import type { EngineeringState } from "./types";
import { ImplementationPanel } from "./implementation-panel";
import { EvaluationPanel } from "../evaluations/evaluation-panel";
import { WorkflowRunPanel } from "../grouped-execution/workflow-run-panel";
import { AgentPanel } from "./agent-panel";
import "./engineer.css";
export function EngineerClient({ id }: { id: string }) {
  const [state, setState] = useState<EngineeringState | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [action, setAction] = useState(""),
    [tab, setTab] = useState("Implementation"),
    [selectedPlan, setSelectedPlan] = useState(""),
    [selectedCode, setSelectedCode] = useState(""),
    [agentView, setAgentView] = useState("Code"),
    [specChoice, setSpecChoice] = useState("");
  const stateUrl = `/api/workflows/${id}/engineering${specChoice ? `?spec=${specChoice}` : ""}`;
  const currentRequest = useRef({ sequence: 0 });
  const load = useCallback(async () => {
    const request = ++currentRequest.current.sequence;
    try {
      const next = await api<EngineeringState>(stateUrl);
      if (request === currentRequest.current.sequence) setState(next);
    } catch (e) {
      if (request === currentRequest.current.sequence)
        setError(errorMessage(e));
    }
  }, [stateUrl]);
  useEffect(() => {
    const tracker = currentRequest.current;
    const request = ++tracker.sequence;
    api<EngineeringState>(stateUrl)
      .then((next) => {
        if (request === tracker.sequence) setState(next);
      })
      .catch((e) => {
        if (request === tracker.sequence) setError(errorMessage(e));
      });
    return () => {
      tracker.sequence++;
    };
  }, [stateUrl]);
  const activeJob = state?.jobs.find((j) =>
    ["queued", "running", "waiting_for_human", "cancel_requested"].includes(
      j.status,
    ),
  );
  const activeJobId = activeJob?.id;
  const latestJob = state?.jobs.find(
    (j) => !j.frozen_spec_id || j.frozen_spec_id === state.spec.id,
  );
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
          View process whiteboard
        </Link>
      }
    >
      <main className="engineer-workspace">
        <div className="engineer-topline">
          {state && (
            <label>
              Frozen process
              <select
                aria-label="Frozen process version"
                value={state.spec.id}
                onChange={(event) => {
                  currentRequest.current.sequence++;
                  setSpecChoice(event.target.value);
                  setSelectedPlan("");
                  setSelectedCode("");
                  setState(null);
                }}
              >
                {state.specs.map((spec) => (
                  <option key={spec.id} value={spec.id}>
                    v{spec.version_number}
                    {spec.id === state.workflow.current_frozen_spec_id
                      ? " · current"
                      : " · history"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {state?.workflow.state !== "frozen" &&
            state?.workflow.base_frozen_spec_id && (
              <span className="status-pill">
                Revision in progress · draft v{state.workflow.process_version}
              </span>
            )}
          <span className="field-help">
            {state?.spec.board.workflow.desired_outcome}
          </span>
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
          <ErrorNotice
            title="Couldn't update the workspace"
            message={error}
            action={
              <button
                onClick={() =>
                  void load()
                    .then(() => setError(""))
                    .catch((e) => setError(errorMessage(e)))
                }
              >
                Reload
              </button>
            }
          />
        )}
        {activeJob && (
          <div className="operation-banner" role="status">
            <div>
              <strong>
                {activeJob.kind === "generation"
                  ? "Generating agent"
                  : "Working"}{" "}
                · frozen v{activeJob.process_version ?? 1} ·{" "}
                {activeJob.phase.replaceAll("_", " ")}
              </strong>
              <p>
                {activeJob.status === "waiting_for_human"
                  ? "This run is paused for a human response in Agent → Run workflow."
                  : activeJob.phase === "queued"
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
        {latestJob?.status === "failed" && (
          <ErrorNotice
            title={
              latestJob.error_code === "GENERATION_NEEDS_ATTENTION"
                ? "Generation needs an engineer decision"
                : `${latestJob.kind === "generation" ? "Generation" : "Operation"} couldn't finish`
            }
            message={
              latestJob.error_message || "No further details were provided."
            }
            guidance={
              latestJob.error_code === "GENERATION_NEEDS_ATTENTION"
                ? "The approved plan couldn't satisfy the frozen requirements. Read the explanation, then review the implementation choices."
                : undefined
            }
            action={
              latestJob.error_code === "GENERATION_NEEDS_ATTENTION" &&
              tab !== "Implementation" ? (
                <button onClick={() => setTab("Implementation")}>
                  Review implementation
                </button>
              ) : undefined
            }
          />
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
            key={state.spec.id}
            state={state}
            selectedPlan={selectedPlan}
            setSelectedPlan={setSelectedPlan}
            busy={busy}
            operationActive={!!activeJob}
            mutate={mutate}
            onGenerated={() => setTab("Agent")}
          />
        ) : tab === "Agent" ? (
          <>
            <nav className="button-row agent-tools" aria-label="Agent tools">
              {["Code", "Run workflow"].map((view) => (
                <button
                  key={view}
                  aria-pressed={agentView === view}
                  onClick={() => setAgentView(view)}
                >
                  {view}
                </button>
              ))}
            </nav>
            {agentView === "Run workflow" ? (
              <WorkflowRunPanel
                key={state.spec.id}
                state={state}
                operationActive={!!activeJob}
                onOperationStarted={load}
                onInspectCode={(id) => {
                  setSelectedCode(id);
                  setAgentView("Code");
                }}
              />
            ) : (
              <AgentPanel
                key={`${state.spec.id}:${selectedCode}`}
                initialVersionId={selectedCode}
                workflowId={id}
                versions={state.versions}
                jobs={state.jobs}
                nodeTitles={Object.fromEntries(
                  state.spec.board.nodes.map((n) => [n.id, n.title]),
                )}
                generating={
                  activeJob?.kind === "generation" &&
                  activeJob.frozen_spec_id === state.spec.id
                }
              />
            )}
          </>
        ) : (
          <EvaluationPanel
            key={state.spec.id}
            state={state}
            operationActive={!!activeJob}
            onOperationStarted={load}
            onInspectCode={(id) => {
              setSelectedCode(id);
              setAgentView("Code");
              setTab("Agent");
            }}
          />
        )}
        {!!state?.jobs.length && (
          <details className="operation-history">
            <summary>Operation history · {state.jobs.length}</summary>
            {state.jobs.map((j) => (
              <div key={j.id}>
                <strong>
                  {j.kind} · {j.status} · frozen v{j.process_version ?? 1}
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
