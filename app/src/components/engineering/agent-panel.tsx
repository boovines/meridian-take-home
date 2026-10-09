"use client";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { ImplementationVersion, WorkflowJob } from "@/domain/engineering";
import type { VersionDetail } from "./types";
export function AgentPanel({
  workflowId,
  initialVersionId = "",
  versions,
  generating = false,
  jobs,
  nodeTitles,
}: {
  workflowId: string;
  initialVersionId?: string;
  versions: ImplementationVersion[];
  generating?: boolean;
  jobs: WorkflowJob[];
  nodeTitles: Record<string, string>;
}) {
  const [selected, setSelected] = useState(initialVersionId),
    [detail, setDetail] = useState<VersionDetail | null>(null),
    [file, setFile] = useState("run-step.mjs"),
    [changes, setChanges] = useState(false),
    [error, setError] = useState("");
  const versionId = versions.some((v) => v.id === selected)
    ? selected
    : versions[0]?.id;
  useEffect(() => {
    if (!versionId) return;
    let active = true;
    api<VersionDetail>(`/api/workflows/${workflowId}/versions/${versionId}`)
      .then((d) => {
        if (active) {
          setDetail(d);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [workflowId, versionId]);
  if (!versionId)
    return (
      <div className="engineer-empty">
        <h2>
          {generating
            ? "Your first code version is being prepared."
            : "No generated versions yet."}
        </h2>
        <p>
          {generating
            ? "Progress is saved in the background. You can leave this page and return to inspect the finished project."
            : "Start generation from an approved implementation plan. Completed versions will appear here for inspection and download."}
        </p>
      </div>
    );
  const ready = detail?.version.id === versionId,
    change = detail?.changes.find((c) => c.path === file);
  const job = jobs.find((j) => j.id === detail?.version.created_by_job_id);
  const buildLabel =
    detail?.build_check_status === "failed"
      ? "Syntax check failed"
      : detail?.build_check_status === "passed"
        ? "Syntax check passed"
        : job?.progress.engine === "fixture"
          ? "Fixture build result"
          : job?.progress.syntax_status === "failed"
            ? "Syntax check failed"
            : job?.progress.syntax_status === "passed" ||
                (job?.status === "succeeded" && job.progress.check === "node --check")
              ? "Syntax check passed"
              : "Build check incomplete";
  const fileLabel = (path: string) => {
    const nodeId = Object.entries(detail?.project.node_file_map || {}).find(
      ([, file]) => file === path,
    )?.[0];
    return nodeId ? `steps / ${nodeTitles[nodeId] || nodeId}` : path;
  };
  return (
    <section aria-label="Generated agent">
      <div className="engineer-section-heading">
        <div className="button-row">
          <label>
            Code version{" "}
            <select
              aria-label="Code version"
              value={versionId}
              onChange={(e) => setSelected(e.target.value)}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version_number} ·{" "}
                  {new Date(v.created_at).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          <span className="status-pill">
            {ready && detail.evaluation
              ? `${detail.evaluation.verdict || detail.evaluation.status} · suite v${detail.evaluation.suite_number}`
              : "Not yet evaluated"}
          </span>
        </div>
        <a
          className="button-link"
          href={`/api/workflows/${workflowId}/versions/${versionId}/download`}
        >
          Download project
        </a>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {!ready ? (
        <p role="status">Loading source…</p>
      ) : (
        <>
          <p className="field-help">{detail.project.generator.summary}</p>
          <p className="field-help">
            {buildLabel}.{" "}
            {detail.evaluation
              ? "See Evaluation for the latest expected-versus-actual results."
              : "Business behavior has not been evaluated."}
          </p>
          {job?.progress.diagnostic !== undefined && (
            <details>
              <summary>Build diagnostic</summary>
              <pre className="build-diagnostic">
                {JSON.stringify(job.progress.diagnostic, null, 2)}
              </pre>
            </details>
          )}
          <div className="source-layout">
            <nav aria-label="Project files">
              {detail.changes.map((c) => (
                <button
                  key={c.path}
                  title={c.path}
                  aria-pressed={file === c.path}
                  onClick={() => setFile(c.path)}
                >
                  <span>{fileLabel(c.path)}</span>
                  {c.status !== "unchanged" && <small>{c.status}</small>}
                </button>
              ))}
            </nav>
            <div className="source-content">
              <div className="source-heading">
                <strong>{file}</strong>
                <label className="approval-check">
                  <input
                    type="checkbox"
                    checked={changes}
                    onChange={(e) => setChanges(e.target.checked)}
                    disabled={!detail.version.parent_version_id}
                  />{" "}
                  Compare with parent
                </label>
              </div>
              {changes &&
                change?.before !== null &&
                change?.before !== undefined && (
                  <>
                    <h3>Parent version</h3>
                    <pre tabIndex={0} aria-label="Parent source">
                      {change.before}
                    </pre>
                    <h3>Selected version</h3>
                  </>
                )}
              <pre tabIndex={0} aria-label="Source code">
                {detail.project.files[file] ?? "This file was removed."}
              </pre>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
