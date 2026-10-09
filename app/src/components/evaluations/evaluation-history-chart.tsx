"use client";
import { useState } from "react";
import type { EvaluationState } from "./types";
import { OutcomeBar, outcomeLabels } from "./evaluation-statistics";

export function EvaluationHistoryChart({
  history,
  selectedRunId,
  onSelect,
}: {
  history: EvaluationState;
  selectedRunId?: string;
  onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const runs = (
    expanded ? history.runs : history.runs.slice(0, 5)
  ).toReversed();
  return (
    <section
      className="eval-history-chart"
      aria-label="Recent evaluation outcomes"
    >
      <div className="eval-chart-heading">
        <h3>Recent evaluations</h3>
        <span>Oldest → newest · up to 20 runs</span>
      </div>
      <p className="field-help">
        Each bar accounts for every case in its locked suite. Select a run to inspect
        its evidence. Code, suite and execution settings may differ; these are
        not a repair confirmation score.
      </p>
      <div className="eval-history-rows">
        {runs.map((run) => {
          const stats = history.statistics[run.id];
          const description = stats
            ? Object.entries(outcomeLabels)
                .filter(
                  ([key]) => stats.cases[key as keyof typeof outcomeLabels],
                )
                .map(
                  ([key, label]) =>
                    `${stats.cases[key as keyof typeof outcomeLabels]} ${label.toLowerCase()}`,
                )
                .join(", ")
            : "Statistics unavailable";
          return (
            <button
              key={run.id}
              className="eval-history-row"
              aria-pressed={run.id === selectedRunId}
              onClick={() => onSelect(run.id)}
              aria-label={`Inspect code v${run.code_version_number}, suite v${run.suite_version_number}, ${run.verdict || run.status}, ${description}, ${new Date(run.created_at).toLocaleString()}`}
            >
              <span className="eval-history-identity">
                <strong>
                  Code v{run.code_version_number}{" "}
                  <span>· suite v{run.suite_version_number}</span>
                </strong>
                <small>{new Date(run.created_at).toLocaleString()}</small>
              </span>
              <span className="eval-history-evidence">
                {stats && <OutcomeBar counts={stats.cases} />}
                <small>{description}</small>
              </span>
              <span className="eval-history-score">
                <strong>
                  {stats ? `${stats.cases.passed}/${stats.cases.total}` : "—"}
                </strong>
                <small data-result={run.verdict}>
                  {run.verdict || run.status}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      {history.runs.length > 5 && (
        <button
          className="subtle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? "Show latest 5"
            : `Show all ${history.runs.length} loaded runs`}
        </button>
      )}
    </section>
  );
}
