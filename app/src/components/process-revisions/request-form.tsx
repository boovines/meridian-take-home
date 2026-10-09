"use client";
import { useRef, useState } from "react";
import type { EngineeringState } from "../engineering/types";
import { api, errorMessage } from "@/lib/api";
import { ErrorNotice } from "../error-notice";
export interface RequestEntryProps {
  state: EngineeringState;
}
export function useRequestDraft(state: EngineeringState) {
  const [open, setOpen] = useState(false),
    [body, setBody] = useState(""),
    [nodes, setNodes] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [sent, setSent] = useState(false);
  const request = useRef<{ signature: string; key: string } | null>(null);
  async function submit() {
    setBusy(true);
    setError("");
    const signature = JSON.stringify({ body, nodes, spec: state.spec.id });
    if (request.current?.signature !== signature)
      request.current = { signature, key: crypto.randomUUID() };
    try {
      await api(`/api/workflows/${state.workflow.id}/change-requests`, "POST", {
        body,
        node_ids: nodes,
        source_frozen_spec_id: state.spec.id,
        request_key: request.current.key,
      });
      setSent(true);
      setOpen(false);
      setBody("");
      setNodes([]);
      request.current = null;
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return {
    open,
    setOpen,
    body,
    setBody,
    nodes,
    setNodes,
    busy,
    error,
    sent,
    submit,
  };
}
export function RequestForm({
  state,
  draft,
}: {
  state: EngineeringState;
  draft: ReturnType<typeof useRequestDraft>;
}) {
  return (
    <form
      className="process-request-form"
      onSubmit={(event) => {
        event.preventDefault();
        void draft.submit();
      }}
    >
      <p className="field-help">
        Ask the process expert to clarify or revise frozen v
        {state.spec.version_number}. They decide what to change; sending this
        request keeps the approved process locked.
      </p>
      {draft.error && (
        <ErrorNotice title="Request couldn't be sent" message={draft.error} />
      )}
      <label>
        What needs to change?
        <textarea
          autoFocus
          value={draft.body}
          onChange={(e) => draft.setBody(e.target.value)}
          required
          maxLength={20000}
          rows={5}
          placeholder="Describe the missing rule, ambiguity, or change in the process…"
          disabled={draft.busy}
        />
      </label>
      <fieldset disabled={draft.busy}>
        <legend>
          Affected blocks <span className="field-help">(optional)</span>
        </legend>
        <div className="request-targets">
          {state.spec.board.nodes.map((node) => (
            <label key={node.id}>
              <input
                type="checkbox"
                checked={draft.nodes.includes(node.id)}
                onChange={(e) =>
                  draft.setNodes(
                    e.target.checked
                      ? [...draft.nodes, node.id]
                      : draft.nodes.filter((id) => id !== node.id),
                  )
                }
              />
              {node.title || node.type}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="button-row">
        <button
          type="button"
          disabled={draft.busy}
          onClick={() => draft.setOpen(false)}
        >
          Cancel
        </button>
        <button className="primary" disabled={draft.busy}>
          {draft.busy ? "Sending…" : "Send request"}
        </button>
      </div>
    </form>
  );
}
export function RequestStatus({
  state,
  sent,
}: {
  state: EngineeringState;
  sent: boolean;
}) {
  return (
    <div role="status" className="field-help">
      {sent && (
        <>
          Request sent.{" "}
          <a
            className="request-link"
            href={`/workflows/${state.workflow.id}?review=requests`}
          >
            Open the whiteboard conversation
          </a>
        </>
      )}
    </div>
  );
}
