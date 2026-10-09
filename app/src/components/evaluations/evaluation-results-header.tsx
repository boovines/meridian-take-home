import { EvaluationStatistics } from "./evaluation-statistics";
import { EvaluationHistoryChart } from "./evaluation-history-chart";
import type { EvaluationRun } from "@/domain/evaluation";
import type { EvaluationState } from "./types";

export function EvaluationResultsHeader({
  history,
  selectedRunId,
  currentRun,
  readyRun,
  repairReason,
  busy,
  operationActive,
  onSelect,
  onRerun,
  onRepair,
}: {
  history: EvaluationState | null;
  selectedRunId: string | undefined;
  currentRun: EvaluationRun | undefined;
  readyRun: EvaluationState | null;
  repairReason: string | null;
  busy: boolean;
  operationActive: boolean;
  onSelect: (id: string) => void;
  onRerun: (codeId: string, suiteId: string) => void;
  onRepair: () => void;
}) {
  return (
    <>
      <div className="evaluation-run-heading">
        <label>
          Evaluation history
          <select
            value={selectedRunId || ""}
            onChange={(e) => {
              onSelect(e.target.value);
            }}
          >
            {currentRun &&
              !history?.runs.some((r) => r.id === currentRun.id) && (
                <option value={currentRun.id}>
                  {new Date(currentRun.created_at).toLocaleString()} ·{" "}
                  {currentRun.verdict || currentRun.status}
                </option>
              )}
            {history?.runs.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.created_at).toLocaleString()} ·{" "}
                {r.verdict || r.status}
              </option>
            ))}
          </select>
        </label>
        {currentRun && (
          <>
            <button
              disabled={busy || operationActive}
              onClick={() =>
                onRerun(
                  currentRun.implementation_version_id,
                  currentRun.suite_version_id,
                )
              }
            >
              Run these versions again
            </button>
            <button
              className="primary"
              disabled={busy || operationActive || !!repairReason}
              title={
                repairReason ||
                "Start up to three repairs with full regression checks."
              }
              onClick={onRepair}
            >
              Repair and rerun
            </button>
            <div>
              <strong data-result={currentRun.verdict}>
                {currentRun.verdict || currentRun.status}
              </strong>
              <p className="field-help">
                Code v{currentRun.code_version_number || "—"} · suite v
                {currentRun.suite_version_number || "—"} ·{" "}
                {readyRun
                  ? (readyRun.statistics[currentRun.id]?.cases.passed ?? "—")
                  : "—"}{" "}
                /{" "}
                {readyRun
                  ? (readyRun.statistics[currentRun.id]?.cases.total ?? "—")
                  : "—"}{" "}
                cases passed
              </p>
            </div>
          </>
        )}
      </div>
      {currentRun && (
        <p className="repair-guidance">
          {repairReason ||
            "Repair runs up to three attempts. The frozen process, approved methods, and verified suite stay fixed."}
        </p>
      )}
      {readyRun && selectedRunId && readyRun.statistics[selectedRunId] ? (
        <EvaluationStatistics statistics={readyRun.statistics[selectedRunId]} />
      ) : (
        <p role="status">Loading evaluation statistics…</p>
      )}
      {history && history.runs.length > 0 && (
        <EvaluationHistoryChart
          history={history}
          selectedRunId={selectedRunId}
          onSelect={onSelect}
        />
      )}
      {currentRun?.failure_message && (
        <p role="status" className="error-banner">
          {currentRun.failure_message}
        </p>
      )}
    </>
  );
}
