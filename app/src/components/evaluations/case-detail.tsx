"use client";
import { useEffect, useState } from "react";
import type { EvaluationCase, CaseResult } from "@/domain/evaluation";
import { RunTrace } from "../runtime/run-trace";
import { AuditTrail } from "../runtime/audit-trail";
import { api, errorMessage } from "@/lib/api";
export function CaseDetail({
  test,
  result,
  workflowId,
  nodeTitles,
}: {
  test: EvaluationCase;
  result?: CaseResult;
  workflowId: string;
  nodeTitles: Record<string, string>;
}) {
  const [input, setInput] = useState<{ id: string; manifest: unknown } | null>(
      null,
    ),
    [error, setError] = useState("");
  useEffect(() => {
    if (!test.input_bundle_id) return;
    let active = true;
    api<{ id: string; manifest: unknown }>(
      `/api/workflows/${workflowId}/input-bundles/${test.input_bundle_id}`,
    )
      .then((v) => {
        if (active) setInput(v);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [workflowId, test.input_bundle_id]);
  const [trace, setTrace] = useState(false);
  return (
    <div className="case-detail">
      <div className="case-detail-heading">
        <div>
          <span className="eyebrow">
            {test.kind === "workflow" ? "Full workflow" : "Step check"}
          </span>
          <h3>{test.name}</h3>
        </div>
        <span className="status-pill" data-result={result?.outcome}>
          {result
            ? result.outcome?.replaceAll("_", " ") || result.status
            : test.verified_at
              ? "Verified"
              : "Needs verification"}
        </span>
      </div>
      {result?.failure_message && (
        <p role="status" className="error-banner">
          <strong>{result.failure_category || "Execution"} error.</strong>{" "}
          {result.failure_message}
        </p>
      )}
      <div className="assertion-results">
        {test.assertions.map((a) => {
          const r = result?.check_results.find((c) => c.key === a.key);
          return (
            <div key={a.key} className="assertion-result">
              <div>
                <strong>{a.label}</strong>
                <small>
                  {a.path.length ? a.path.join(" → ") : "Whole output"}
                </small>
              </div>
              {result && (
                <span
                  data-result={r ? (r.passed ? "passed" : "failed") : "not_run"}
                >
                  {r ? (r.passed ? "Pass" : "Fail") : "Not checked"}
                </span>
              )}
              <dl>
                <div>
                  <dt>
                    {a.operator === "contains_record"
                      ? "Required record"
                      : a.operator === "excludes_record"
                        ? "Forbidden record"
                        : "Expected"}
                  </dt>
                  <dd>
                    <pre>{JSON.stringify(a.expected, null, 2)}</pre>
                  </dd>
                </div>
                {result && (
                  <div>
                    <dt>Actual</dt>
                    <dd>
                      <pre>
                        {r
                          ? r.missing
                            ? "Missing field"
                            : JSON.stringify(r.actual, null, 2)
                          : "Not available"}
                      </pre>
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          );
        })}
      </div>
      <details>
        <summary>Inspect test inputs</summary>
        {error && <p role="alert">{error}</p>}
        <pre tabIndex={0}>
          {test.kind === "step"
            ? JSON.stringify(test.input_data, null, 2)
            : input?.id === test.input_bundle_id
              ? JSON.stringify(input.manifest, null, 2)
              : "Loading captured input…"}
        </pre>
        {!!test.human_responses.length && (
          <>
            <h4>Scripted human responses</h4>
            <pre tabIndex={0}>
              {JSON.stringify(test.human_responses, null, 2)}
            </pre>
          </>
        )}
      </details>
      {result?.workflow_run_id && (
        <div className="case-trace-control">
          <button aria-expanded={trace} onClick={() => setTrace(!trace)}>
            {trace ? "Hide step trace" : "Inspect step trace"}
          </button>
          {trace && (
            <RunTrace
              workflowId={workflowId}
              runId={result.workflow_run_id}
              nodeTitles={nodeTitles}
            />
          )}
        </div>
      )}
      {result?.actual_output !== null &&
        result?.actual_output !== undefined && (
          <details>
            <summary>Complete actual output</summary>
            <pre tabIndex={0}>
              {JSON.stringify(result.actual_output, null, 2)}
            </pre>
          </details>
        )}
      {result && test.kind === "step" && (
        <AuditTrail
          key={result.id}
          workflowId={workflowId}
          caseResultId={result.id}
        />
      )}
    </div>
  );
}
