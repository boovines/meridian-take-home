"use client";
import { useState } from "react";
import type { EngineeringState } from "../engineering/types";
import type { EvaluationCase, EvaluationRun } from "@/domain/evaluation";
import { api, errorMessage } from "@/lib/api";
import { useEvaluationData } from "./use-evaluation-data";
import { EvaluationResultsHeader } from "./evaluation-results-header";
import { EvaluationWorkbench } from "./evaluation-workbench";
import { CaseDetail } from "./case-detail";
import { CaseEditor } from "./case-editor";
import "./evaluations.css";
import { RepairPanel } from "../repairs/repair-panel";
import { repairBlocker } from "@/domain/repair";
export function EvaluationPanel({
  state,
  operationActive,
  onOperationStarted,
  onInspectCode,
}: {
  state: EngineeringState;
  operationActive: boolean;
  onOperationStarted: () => Promise<void>;
  onInspectCode: (id: string) => void;
}) {
  const base = `/api/workflows/${state.workflow.id}`;
  const [suiteId, setSuiteId] = useState(""),
    [versionId, setVersionId] = useState(""),
    [runId, setRunId] = useState(""),
    [mode, setMode] = useState<"cases" | "results" | "repairs">("cases"),
    [selected, setSelected] = useState(""),
    [editing, setEditing] = useState<EvaluationCase | "new" | null>(null),
    [name, setName] = useState("Workflow checks"),
    [busy, setBusy] = useState(false);
  const {
    suites,
    history,
    bundles,
    runDetail,
    runCases,
    selectedRunId,
    currentRun,
    load,
    error,
    setError,
  } = useEvaluationData(base, suiteId, runId, operationActive, state.spec.id);
  const suite =
      suites?.suites.find((s) => s.id === suites.selected_suite_id) ||
      suites?.suites[0],
    codeId = versionId || state.versions[0]?.id;
  async function act(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function create(parent = false) {
    if (parent && !suite) return;
    await act(async () => {
      const next = await api<{ id: string }>(`${base}/suites`, "POST", {
        frozen_spec_id: state.spec.id,
        request_key: crypto.randomUUID(),
        name: parent ? suite!.name : name,
        parent_suite_version_id: parent ? suite!.id : null,
      });
      setSuiteId(next.id);
      setMode("cases");
      setSelected("");
    });
  }
  async function start(targetCode = codeId, targetSuite = suite?.id, autoRepair = false) {
    if (!targetSuite || !targetCode) return;
    await act(async () => {
      const result = await api<{ evaluation: EvaluationRun }>(
        `${base}/evaluations`,
        "POST",
        {
          request_key: crypto.randomUUID(),
          implementation_version_id: targetCode,
          suite_version_id: targetSuite,
          ...(autoRepair ? { auto_repair: true } : {}),
        },
      );
      setRunId(result.evaluation.id);
      setMode("results");
      setSelected("");
      await onOperationStarted();
    });
  }
  async function repair() {
    if (!selectedRunId) return;
    await act(async () => {
      await api(`${base}/repairs`, "POST", {
        request_key: crypto.randomUUID(),
        baseline_evaluation_id: selectedRunId,
      });
      setMode("repairs");
      await onOperationStarted();
    });
  }
  const readyRun = runDetail?.runs[0]?.id === selectedRunId ? runDetail : null;
  const repairReason = readyRun
    ? repairBlocker(readyRun.runs[0], readyRun.results) ||
      (suites?.suites.some(
        (s) =>
          s.version_number >
          (runCases?.suites.find(
            (s) => s.id === readyRun.runs[0].suite_version_id,
          )?.version_number || 0),
      )
        ? "Evaluate against the latest verified suite revision before repairing."
        : null)
    : "Loading evaluation evidence…";
  const cases =
    mode === "cases"
      ? suites?.cases || []
      : readyRun
        ? runCases?.cases || []
        : [];
  const items = cases.map((c) => {
    const r = readyRun?.results.find((r) => r.case_id === c.id);
    return {
      id: c.id,
      name: c.name,
      description: c.kind === "workflow" ? "Full workflow" : "One step",
      status:
        mode === "results"
          ? r?.outcome || r?.status || "queued"
          : c.verified_at
            ? "verified"
            : "unverified",
    };
  });
  const test = cases.find((c) => c.id === selected) || cases[0],
    result =
      mode === "results"
        ? readyRun?.results.find((r) => r.case_id === test?.id)
        : undefined;
  if (!suites)
    return (
      <div>
        {error ? (
          <p role="alert" className="error-banner">
            {error}{" "}
            <button
              onClick={() =>
                void load().catch((e) => setError(errorMessage(e)))
              }
            >
              Retry
            </button>
          </p>
        ) : (
          <p role="status">Loading evaluation workspace…</p>
        )}
      </div>
    );
  return (
    <section aria-label="Evaluation workspace" className="evaluation-panel">
      <div className="engineer-section-heading">
        <div>
          <h2>
            {mode === "repairs"
              ? "Repair history"
              : mode === "results"
                ? "Evaluation results"
                : "Define trusted test cases"}
          </h2>
          <p className="field-help">
            {mode === "repairs"
              ? "Inspect each candidate and the evidence for keeping or rejecting it."
              : "Verify the cases, lock the suite, then compare a code version against it."}
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {!suite ? (
        <form
          className="suite-create"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label>
            Suite name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
            />
          </label>
          <button className="primary" disabled={busy}>
            Create test suite
          </button>
        </form>
      ) : (
        <>
          {mode === "cases" && (
            <>
              <div className="evaluation-controls">
                <label>
                  Test suite
                  <select
                    value={suite.id}
                    disabled={!!editing}
                    onChange={(e) => {
                      setSuiteId(e.target.value);
                      setSelected("");
                      setMode("cases");
                    }}
                  >
                    {suites.suites.map((s) => (
                      <option key={s.id} value={s.id}>
                        v{s.version_number} · {s.name} · {s.state}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Code to evaluate
                  <select
                    value={codeId || ""}
                    onChange={(e) => setVersionId(e.target.value)}
                  >
                    <option value="" disabled>
                      No generated code
                    </option>
                    {state.versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.version_number} ·{" "}
                        {new Date(v.created_at).toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    operationActive ||
                    suite.state !== "locked" ||
                    !codeId ||
                    !!editing
                  }
                  onClick={() => void start()}
                >
                  Run full suite
                </button>
                <button
                  className="primary"
                  disabled={busy || operationActive || suite.state !== "locked" || !codeId || !!editing || suites.suites.some(s => s.version_number > suite.version_number)}
                  onClick={() => void start(codeId, suite.id, true)}
                  aria-describedby="automatic-repair-help"
                >
                  Evaluate and repair
                </button>
              </div>
              <p className="field-help">
                {operationActive
                  ? "An operation is active. Existing cases and results remain available."
                  : suite.state !== "locked"
                    ? "Every case must be verified before the suite can be locked and run."
                    : !codeId
                      ? "Generate a code version before running this suite."
                      : "Expected answers are locked. Each run preserves the exact suite and code versions."}
              </p>
            </>
          )}
          {mode === "cases" && <p id="automatic-repair-help" className="field-help">
            Evaluate and repair runs the full suite, then automatically repairs and retests failures.
            Stops when all checks pass or after three repair attempts; service or input problems need attention.
            Uses additional AI credits and continues if you leave this page. Follow progress in Repair history.
          </p>}
          <div className="evaluation-navigation">
            <div className="button-row" aria-label="Evaluation views">
              <button
                aria-pressed={mode === "cases"}
                disabled={!!editing}
                onClick={() => {
                  setMode("cases");
                  setSelected("");
                }}
              >
                Test cases · {suites.cases.length}
              </button>
              <button
                aria-pressed={mode === "results"}
                disabled={!!editing}
                onClick={() => {
                  setMode("results");
                  setSelected("");
                }}
              >
                Results & history · {history?.runs.length || 0}
              </button>
              <button
                aria-pressed={mode === "repairs"}
                disabled={!!editing}
                onClick={() => setMode("repairs")}
              >
                Repair history
              </button>
            </div>
            {mode === "cases" && !editing && (
              <div className="button-row">
                {suite.state === "draft" ? (
                  <>
                    <button disabled={busy} onClick={() => setEditing("new")}>
                      Add case
                    </button>
                    <button
                      disabled={
                        busy ||
                        !suites.cases.length ||
                        suites.cases.some((c) => !c.verified_at)
                      }
                      onClick={() =>
                        void act(async () => {
                          await api(`${base}/suites/${suite.id}/lock`, "POST", {
                            expected_revision: suite.revision,
                          });
                        })
                      }
                    >
                      Lock verified suite
                    </button>
                  </>
                ) : (
                  <button
                    disabled={
                      busy || suites.suites.some((s) => s.state === "draft")
                    }
                    onClick={() => void create(true)}
                  >
                    Create suite revision
                  </button>
                )}
              </div>
            )}
          </div>
          {mode === "repairs" ? (
            <RepairPanel
              workflowId={state.workflow.id}
              versions={state.versions}
              operationActive={operationActive}
              onInspectCode={onInspectCode}
              onInspectEvaluation={(id) => {
                setRunId(id);
                setMode("results");
                setSelected("");
              }}
            />
          ) : editing ? (
            <CaseEditor
              key={editing === "new" ? "new" : editing.id}
              initial={editing === "new" ? undefined : editing}
              nodes={state.spec.board.nodes}
              bundles={bundles}
              onCancel={() => setEditing(null)}
              onSave={async (data) => {
                await api(
                  `${base}/suites/${suite.id}/cases${editing === "new" ? "" : `/${editing.id}`}`,
                  editing === "new" ? "POST" : "PATCH",
                  editing === "new"
                    ? data
                    : { expected_revision: editing.revision, case: data },
                );
                await load();
                setEditing(null);
              }}
            />
          ) : mode === "results" && !history?.runs.length ? (
            <div className="engineer-empty">
              <h3>No evaluation results yet.</h3>
              <p>
                A syntax check does not verify business behavior. Run a locked
                suite to see expected and actual results here.
              </p>
            </div>
          ) : (
            <>
              {mode === "results" && (
                <EvaluationResultsHeader
                  history={history}
                  selectedRunId={selectedRunId}
                  currentRun={currentRun}
                  readyRun={readyRun}
                  repairReason={repairReason}
                  busy={busy}
                  operationActive={operationActive}
                  onSelect={(id) => {
                    setRunId(id);
                    setSelected("");
                  }}
                  onRerun={(codeId, suiteId) => {
                    void start(codeId, suiteId);
                  }}
                  onRepair={() => {
                    void repair();
                  }}
                />
              )}
              <EvaluationWorkbench
                items={items}
                selected={test?.id || ""}
                onSelect={setSelected}
                empty={
                  mode === "cases"
                    ? "Add a case with captured inputs and independently verified answers."
                    : "Loading this evaluation…"
                }
              >
                {test && (
                  <>
                    <CaseDetail
                      key={`${test.id}-${result?.id || "definition"}`}
                      test={test}
                      result={result}
                      workflowId={state.workflow.id}
                      nodeTitles={Object.fromEntries(
                        state.spec.board.nodes.map((n) => [n.id, n.title]),
                      )}
                    />
                    {mode === "cases" && suite.state === "draft" && (
                      <div className="case-actions">
                        <button
                          disabled={busy}
                          onClick={() => setEditing(test)}
                        >
                          Edit case
                        </button>
                        <button
                          className="primary"
                          disabled={busy || !!test.verified_at}
                          onClick={() =>
                            void act(async () => {
                              await api(
                                `${base}/suites/${suite.id}/cases/${test.id}/verify`,
                                "POST",
                                { expected_revision: test.revision },
                              );
                            })
                          }
                        >
                          {test.verified_at
                            ? "Verified"
                            : "Verify inputs & answers"}
                        </button>
                        <button
                          className="subtle"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await api(
                                `${base}/suites/${suite.id}/cases/${test.id}`,
                                "DELETE",
                                { expected_revision: test.revision },
                              );
                            })
                          }
                        >
                          Remove from draft
                        </button>
                      </div>
                    )}
                  </>
                )}
              </EvaluationWorkbench>
            </>
          )}
        </>
      )}
    </section>
  );
}
