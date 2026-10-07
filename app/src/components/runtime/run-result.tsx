"use client";
import type { Json } from "@/domain/runtime";
export function RunResult({ output }: { output: Json }) {
  const object =
    output && typeof output === "object" && !Array.isArray(output)
      ? output
      : null;
  const report =
    object?.report &&
    typeof object.report === "object" &&
    !Array.isArray(object.report)
      ? object.report
      : null;
  const totals =
    object?.totals &&
    typeof object.totals === "object" &&
    !Array.isArray(object.totals)
      ? Object.entries(object.totals)
          .filter(([, v]) => typeof v === "number")
          .slice(0, 12)
      : [];
  return (
    <div className="run-result">
      {!!totals.length && (
        <dl className="run-totals">
          {totals.map(([key, value]) => (
            <div key={key}>
              <dt>{key.replaceAll("_", " ")}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {report &&
        typeof report.subject === "string" &&
        typeof report.body === "string" && (
          <section className="report-preview" aria-label="Report preview">
            <div className="preview-label">
              <strong>Report preview</strong>
              <span>Not sent</span>
            </div>
            {typeof report.recipient === "string" && (
              <p>
                <span>To</span> {report.recipient}
              </p>
            )}
            <h4>{report.subject}</h4>
            <p className="preserve-lines">{report.body}</p>
          </section>
        )}
      <details open={!report}>
        <summary>Complete result</summary>
        <pre tabIndex={0}>{JSON.stringify(output, null, 2)}</pre>
      </details>
    </div>
  );
}
