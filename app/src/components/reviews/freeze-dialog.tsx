"use client";
import { useEffect, useState } from "react";
import type { Board } from "@/domain/canvas";
import type { StructuralIssue } from "@/domain/validate-graph";
import { Dialog } from "../dialog";
import { api, errorMessage } from "@/lib/api";
interface Readiness {
  board: Board;
  issues: StructuralIssue[];
  open_findings: { id: string; title: string }[];
  completed_review_id: string | null;
  unreviewed_changes: boolean;
}
export function FreezeDialog({
  workflowId,
  onClose,
  onFrozen,
  onLocate,
}: {
  workflowId: string;
  onClose: () => void;
  onFrozen: () => Promise<void>;
  onLocate: (issue: StructuralIssue) => void;
}) {
  const [ready, setReady] = useState<Readiness | null>(null),
    [error, setError] = useState(""),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api<Readiness>(`/api/workflows/${workflowId}/freeze`)
      .then((r) => {
        if (active) setReady(r);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [workflowId]);
  const canFreeze =
    ready?.completed_review_id &&
    !ready.open_findings.length &&
    !ready.issues.length &&
    (!ready.unreviewed_changes || ack) &&
    ready.board.workflow.state === "draft";
  async function freeze() {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/workflows/${workflowId}/freeze`, "POST", {
        expected_content_revision: ready.board.workflow.content_revision,
        acknowledge_unreviewed: ack,
      });
      await onFrozen();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setReady(
        await api<Readiness>(`/api/workflows/${workflowId}/freeze`).catch(
          () => null,
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog labelledBy="freeze-title" onClose={onClose}>
      <h2 id="freeze-title">Ready to hand off?</h2>
      <p>
        Freezing saves this process and its review decisions for the engineer.
        The board will be locked for the demo.
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {!ready ? (
        <p>Checking the workflow…</p>
      ) : (
        <div className="freeze-checklist">
          <p>
            {ready.completed_review_id
              ? "✓ A draft review is complete"
              : "Complete at least one draft review first."}
          </p>
          {ready.board.workflow.state === "reviewing" && (
            <p>Wait for the active review or cancel it.</p>
          )}
          {ready.open_findings.length ? (
            <>
              <strong>Resolve these findings first</strong>
              <ul>
                {ready.open_findings.map((f) => (
                  <li key={f.id}>{f.title}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>✓ All AI findings have a recorded decision</p>
          )}
          {ready.issues.length ? (
            <>
              <strong>Fix these structural issues</strong>
              <ul>
                {ready.issues.map((i, k) => (
                  <li key={k}>
                    {i.message}
                    {i.repair_steps?.length ? (
                      <ol>
                        {i.repair_steps.map((step, index) => (
                          <li key={index}>
                            {step.instruction}
                            <button
                              className="subtle"
                              onClick={() => {
                                onClose();
                                onLocate({
                                  ...i,
                                  node_id: step.node_id,
                                  connection_id: undefined,
                                });
                              }}
                            >
                              Edit “
                              {ready.board.nodes.find(
                                (node) => node.id === step.node_id,
                              )?.title || "block"}
                              ”
                            </button>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      (i.node_id || i.connection_id) && (
                        <button
                          className="subtle"
                          onClick={() => {
                            onClose();
                            onLocate(i);
                          }}
                        >
                          Show on canvas
                        </button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>✓ The process has a valid structure</p>
          )}
          {ready.unreviewed_changes && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              <span>
                The process changed after its last review. I acknowledge the
                unreviewed changes and want to hand off this version.
              </span>
            </label>
          )}
        </div>
      )}
      <div className="button-row">
        <button onClick={onClose} disabled={busy}>
          Keep editing
        </button>
        <button
          className="primary"
          disabled={!canFreeze || busy}
          onClick={() => void freeze()}
        >
          {busy ? "Freezing…" : "Freeze and hand off"}
        </button>
      </div>
    </Dialog>
  );
}
