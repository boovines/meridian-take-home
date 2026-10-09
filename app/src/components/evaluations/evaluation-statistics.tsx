import type { EvaluationStatistics as Statistics } from "@/domain/evaluation-statistics";

export const outcomeLabels = {
  passed: "Passed",
  failed: "Failed",
  error: "Errors",
  not_run: "Not run",
  running: "Running",
  queued: "Queued",
  missing: "Missing evidence",
} as const;
export function OutcomeBar({ counts }: { counts: Statistics["cases"] }) {
  return (
    <div className="eval-outcome-bar" aria-hidden="true">
      {Object.keys(outcomeLabels).map((key) => {
        const outcome = key as keyof typeof outcomeLabels;
        return (
          counts[outcome] > 0 && (
            <span
              key={key}
              data-outcome={key}
              style={{ flex: counts[outcome] }}
            />
          )
        );
      })}
    </div>
  );
}
export function EvaluationStatistics({
  statistics,
}: {
  statistics: Statistics;
}) {
  const { cases, assertions } = statistics;
  return (
    <section
      className="eval-statistics"
      aria-label="Selected evaluation statistics"
    >
      <div className="eval-metrics">
        <div>
          <span>Cases passed</span>
          <strong dir="ltr">
            {cases.passed}
            <small> / {cases.total}</small>
          </strong>
          <p>Every assertion must pass</p>
        </div>
        <div>
          <span>Assertions passed</span>
          <strong dir="ltr">
            {assertions.passed}
            <small> / {assertions.total}</small>
          </strong>
          <p>
            {assertions.failed} failed · {assertions.unscored} unscored
          </p>
        </div>
        <div>
          <span>Cases scored</span>
          <strong dir="ltr">
            {cases.passed + cases.failed}
            <small> / {cases.total}</small>
          </strong>
          <p>
            {cases.error} errors · {cases.not_run} not run
          </p>
        </div>
      </div>
      <OutcomeBar counts={cases} />
      <ul className="eval-legend" aria-label="Case outcomes">
        {Object.entries(outcomeLabels)
          .filter(([key]) => cases[key as keyof typeof outcomeLabels] > 0)
          .map(([key, label]) => (
            <li key={key}>
              <i data-outcome={key} aria-hidden="true" />
              {label}{" "}
              <strong>{cases[key as keyof typeof outcomeLabels]}</strong>
            </li>
          ))}
      </ul>
      {assertions.unscored > 0 && (
        <p className="field-help">
          Unscored assertions have no conclusive comparison yet. They are not
          passes or assertion failures.
        </p>
      )}
    </section>
  );
}
