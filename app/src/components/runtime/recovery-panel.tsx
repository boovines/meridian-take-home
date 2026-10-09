"use client";
import type { RunRecord } from "@/domain/runtime";
import type { RunRecoveryState } from "@/domain/run-recovery";
import { recoveryEligibility } from "@/domain/run-recovery";
import { RecoveryFrame } from "./recovery-frame";
import "./recovery-panel.css";
export function RecoveryPanel({
  run,
  recovery,
  busy,
  operationActive,
  nodeTitles,
  onRecover,
  onCancel,
  onInspectRun,
  onInspectCode,
}: {
  run: RunRecord;
  recovery: RunRecoveryState | null;
  busy: boolean;
  operationActive: boolean;
  nodeTitles: Record<string, string>;
  onRecover: () => void;
  onCancel: (jobId: string) => void;
  onInspectRun: (id: string) => void;
  onInspectCode: (id: string) => void;
}) {
  if (!recovery) {
    if (!recoveryEligibility(run).eligible) return null;
    return (
      <section className="recovery-entry" aria-label="Run recovery">
        <strong>This implementation can be diagnosed</strong>
        <p>
          Inspect the saved evidence, repair within the approved plan, and rerun
          the same input. Business rules and required human approvals stay
          fixed.
        </p>
        <button
          className="primary"
          disabled={busy || operationActive}
          onClick={onRecover}
        >
          Diagnose and recover
        </button>
      </section>
    );
  }
  const { session, job, attempts } = recovery;
  const active = [
    "queued",
    "running",
    "waiting_for_human",
    "cancel_requested",
  ].includes(job.status);
  const latest = attempts.at(-1);
  const title =
    session.status === "recovered"
      ? "Completed after repair"
      : session.status === "cancelled"
        ? "Recovery canceled"
        : active
          ? "Recovering this run"
          : "Recovery needs attention";
  const summary =
    session.status === "recovered"
      ? "Business results not yet verified. The accepted version is now the default for manual runs; the confirmed evaluation baseline is unchanged."
      : session.stop_reason ||
        latest?.diagnosis?.summary ||
        "Inspecting the failed steps and their source evidence before proposing a repair.";
  return (
    <RecoveryFrame
      title={title}
      summary={summary}
      stage={
        active
          ? job.phase.replaceAll("_", " ")
          : session.status.replaceAll("_", " ")
      }
      count={`Attempt ${latest?.attempt_number ?? 0} of ${session.attempt_limit}`}
      actions={
        active ? (
          <button
            disabled={busy || job.status === "cancel_requested"}
            onClick={() => onCancel(job.id)}
          >
            {job.status === "cancel_requested"
              ? "Stopping…"
              : "Cancel recovery"}
          </button>
        ) : undefined
      }
    >
      <p className="field-help">
        ${recovery.spent_or_reserved_usd.toFixed(2)} spent or reserved of $
        {Number(session.recovery_limits.max_spend_usd).toFixed(2)} ·{" "}
        {Number(session.recovery_limits.active_ms) / 60000} active minutes.
        Human waiting is excluded.
      </p>
      {session.source_run_id && run.id !== session.source_run_id && (
        <button onClick={() => onInspectRun(session.source_run_id!)}>
          Original failed run
        </button>
      )}
      <ol className="recovery-attempts">
        {attempts.map((attempt) => (
          <li key={attempt.id}>
            <div className="recovery-attempt-heading">
              <strong>Attempt {attempt.attempt_number}</strong>
              <span className="status-pill">{attempt.status}</span>
            </div>
            {attempt.diagnosis && (
              <>
                {attempt.diagnosis.summary !== summary && (
                  <p>{attempt.diagnosis.summary}</p>
                )}
                <p className="field-help">
                  {attempt.diagnosis.affected_node_ids
                    .map((id) => nodeTitles[id] || "Removed step")
                    .join(" · ")}
                </p>
              </>
            )}
            {attempt.decision_reason && <p>{attempt.decision_reason}</p>}
            {attempt.error_message && <p>{attempt.error_message}</p>}
            <div className="button-row">
              {attempt.rerun_id && (
                <button onClick={() => onInspectRun(attempt.rerun_id!)}>
                  Evidence &amp; result
                </button>
              )}
              {attempt.candidate_version_id && (
                <button
                  onClick={() => onInspectCode(attempt.candidate_version_id!)}
                >
                  Code &amp; changes
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </RecoveryFrame>
  );
}
