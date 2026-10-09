import type { RepairHistoryProps } from "./types";
export function RepairHistory({
  session,
  attempts,
  confirmations,
  versionLabel,
  onInspectEvaluation,
  onInspectCode,
}: RepairHistoryProps) {
  return (
    <section
      className="repair-ledger repair-sidebar"
      aria-label="Repair attempt history"
    >
      <div className="repair-summary">
        <div>
          <span className="eyebrow">Retained baseline</span>
          <h3>
            {versionLabel(session.baseline_version_id)}{" "}
            <span className="status-pill">
              {session.status.replaceAll("_", " ")}
            </span>
          </h3>
          <p>
            {session.stop_reason ||
              "A candidate replaces this baseline only after the full suite preserves every previously passing assertion."}
          </p>
        </div>
        <button
          disabled={!session.baseline_evaluation_id}
          onClick={() =>
            session.baseline_evaluation_id &&
            onInspectEvaluation(session.baseline_evaluation_id)
          }
        >
          Inspect baseline evaluation
        </button>
      </div>
      <div className="repair-timeline">
        <p className="field-help">
          {attempts.length} / {session.attempt_limit} attempts · Approved
          methods and verified expectations stay fixed.
        </p>
        {attempts.map((a) => (
          <article key={a.id} className="repair-attempt">
            <div className="repair-attempt-heading">
              <div>
                <strong>Attempt {a.attempt_number}</strong>
                <p>
                  {versionLabel(a.baseline_version_id)} →{" "}
                  {a.candidate_version_id
                    ? versionLabel(a.candidate_version_id)
                    : a.status === "running"
                      ? "Generating candidate"
                      : "No candidate created"}
                </p>
              </div>
              <span
                className="status-pill"
                data-result={
                  a.status === "rejected" || a.status === "failed"
                    ? "failed"
                    : a.status === "accepted"
                      ? "passed"
                      : undefined
                }
              >
                {a.status}
              </span>
            </div>
            <div aria-label={`Attempt ${a.attempt_number} confirmation runs`}>
              <p className="field-help">
                {
                  confirmations.filter(
                    (c) => c.attempt_id === a.id && c.verdict === "passed",
                  ).length
                }{" "}
                / 3 complete passes · Same code, suite, and execution settings
                required.
              </p>
              <div className="button-row">
                {confirmations
                  .filter((c) => c.attempt_id === a.id)
                  .map((c) => (
                    <button
                      key={c.evaluation_run_id}
                      onClick={() => onInspectEvaluation(c.evaluation_run_id)}
                    >
                      Run {c.round}: {c.verdict || c.status}
                    </button>
                  ))}
              </div>
              {!confirmations.some((c) => c.attempt_id === a.id) &&
                a.status !== "running" && (
                  <p className="field-help">
                    Historical result; no three-run confirmation recorded.
                  </p>
                )}
            </div>
            <p>
              {a.decision_reason ||
                a.error_message ||
                a.diagnosis?.summary ||
                "Diagnosing the baseline's failures…"}
            </p>
            {a.diagnosis && (
              <details>
                <summary>Diagnosis & changes</summary>
                <p>{a.diagnosis.summary}</p>
                <ul>
                  {a.diagnosis.changes.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="button-row">
              {a.evaluation_run_id && (
                <button
                  onClick={() => onInspectEvaluation(a.evaluation_run_id!)}
                >
                  Inspect attempt {a.attempt_number} evaluation
                </button>
              )}
              {a.candidate_version_id && (
                <button onClick={() => onInspectCode(a.candidate_version_id!)}>
                  Inspect code {versionLabel(a.candidate_version_id)}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
