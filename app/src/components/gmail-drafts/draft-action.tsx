"use client";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { DraftRecord, DraftState } from "@/domain/gmail-drafts";
export function DraftAction({
  workflowId,
  runId,
  recipient = "",
}: {
  workflowId: string;
  runId: string;
  recipient?: string;
}) {
  const [state, setState] = useState<DraftState | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [to, setTo] = useState(recipient);
  const base = `/api/workflows/${workflowId}`,
    url = `${base}/runs/${runId}/gmail-draft`;
  useEffect(() => {
    let active = true;
    api<DraftState>(url)
      .then((s) => {
        if (active) setState(s);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [url]);
  async function act(enable = false) {
    setBusy(true);
    setError("");
    try {
      if (enable) {
        await api(`${base}/gmail-draft-settings`, "POST", { enabled: true });
        setState(await api<DraftState>(url));
      } else {
        const draft = await api<DraftRecord>(url, "POST", { recipient: to });
        setState((s) => (s ? { ...s, draft } : s));
      }
    } catch (e) {
      setError(errorMessage(e));
      setState(await api<DraftState>(url).catch(() => null));
    } finally {
      setBusy(false);
    }
  }
  if (!state?.eligible)
    return error ? (
      <p className="field-help" role="status">
        Gmail drafts: {error}
      </p>
    ) : null;
  return (
    <DraftActionView
      state={state}
      busy={busy}
      error={error}
      to={to}
      onRecipient={setTo}
      onEnable={() => void act(true)}
      onCreate={() => void act()}
    />
  );
}
export function DraftActionView({
  state,
  busy,
  error,
  to,
  onRecipient,
  onEnable,
  onCreate,
}: {
  state: DraftState;
  busy: boolean;
  error: string;
  to: string;
  onRecipient: (value: string) => void;
  onEnable: () => void;
  onCreate: () => void;
}) {
  const draft = state.draft;
  return (
    <section className="report-preview" aria-label="Gmail draft">
      <div className="preview-label">
        <strong>Gmail draft</strong>
        <span>Never sent automatically</span>
      </div>
      {!state.enabled ? (
        <>
          <p>
            Enable draft creation for this workflow only. Test runs stay
            preview-only.
          </p>
          <button disabled={busy} onClick={onEnable}>
            Enable Gmail drafts for this workflow
          </button>
        </>
      ) : draft ? (
        <>
          <p role="status">
            {draft.state === "created"
              ? "Saved in Gmail Drafts. Repeating this action will not create another draft."
              : "Draft creation was requested. Check Gmail Drafts before continuing; the app will not repeat an uncertain request."}
          </p>
          {draft.state === "created" && (
            <a
              href="https://mail.google.com/mail/#drafts"
              target="_blank"
              rel="noreferrer"
            >
              Open Gmail Drafts
            </a>
          )}
        </>
      ) : (
        <>
          <label>
            Recipient (optional)
            <input
              type="email"
              value={to}
              onChange={(e) => onRecipient(e.target.value)}
              placeholder="Leave blank to address in Gmail"
              disabled={busy}
            />
          </label>
          <p className="field-help">
            Saves the preview subject and body to your connected Gmail account.
          </p>
          <button disabled={busy} onClick={onCreate}>
            {busy ? "Creating draft…" : "Create Gmail draft"}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </section>
  );
}
