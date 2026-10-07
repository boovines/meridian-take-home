"use client";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { ImplementationVersion } from "@/domain/engineering";
import type { VersionDetail } from "./types";
export function AgentPanel({
  workflowId,
  versions,
  generating = false,
}: {
  workflowId: string;
  versions: ImplementationVersion[];
  generating?: boolean;
}) {
  const [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<VersionDetail | null>(null),
    [file, setFile] = useState("run-step.mjs"),
    [changes, setChanges] = useState(false),
    [error, setError] = useState("");
  const versionId = selected || versions[0]?.id;
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
          <span className="status-pill">Not yet evaluated</span>
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
          <div className="source-layout">
            <nav aria-label="Project files">
              {detail.changes.map((c) => (
                <button
                  key={c.path}
                  aria-pressed={file === c.path}
                  onClick={() => setFile(c.path)}
                >
                  <span>{c.path}</span>
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
