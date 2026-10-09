"use client";
import { useEffect, useRef, useState } from "react";
import { FileUp, X, Check, Monitor } from "lucide-react";
import { api, errorMessage } from "@/lib/api";
import {
  importProcessMoments,
  type ProcessContextRecord,
  type RawProcessContext,
} from "@/domain/process-context";

export interface ProcessContextPanelProps {
  workflowId: string;
  locked: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}
export function ProcessContextPanel({
  workflowId,
  locked,
  onClose,
  onSaved,
}: ProcessContextPanelProps) {
  const dialog = useRef<HTMLDialogElement>(null),
    file = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<ProcessContextRecord | null>(null);
  const [moments, setMoments] = useState<RawProcessContext["moments"]>([]);
  const [selected, setSelected] = useState<string[]>([]),
    [label, setLabel] = useState("Process demonstration");
  const [paste, setPaste] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [status, setStatus] = useState("");
  const [confirmation, setConfirmation] = useState<
    "remove" | "close" | "reload" | null
  >(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmation) {
      confirmButton.current?.focus();
      confirmButton.current?.scrollIntoView({ block: "nearest" });
    }
  }, [confirmation]);
  const [inspect, setInspect] = useState<string | null>(null);
  const endpoint = `/api/workflows/${workflowId}/process-context`;
  function adopt(value: ProcessContextRecord) {
    setSaved(value);
    setMoments(value.context?.moments ?? []);
    setSelected(value.context?.moments.map((m) => m.id) ?? []);
    setLabel(value.context?.label ?? "Process demonstration");
    setDirty(false);
    setPaste("");
    setInspect(value.context?.moments[0]?.id ?? null);
  }
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    api<ProcessContextRecord>(endpoint)
      .then((value) => {
        if (active) adopt(value);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [endpoint]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function close() {
    if (busy) return;
    if (confirmation) {
      setConfirmation(null);
      return;
    }
    if (dirty) setConfirmation("close");
    else onClose();
  }
  async function reloadSaved() {
    setBusy(true);
    try {
      adopt(await api<ProcessContextRecord>(endpoint));
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function preview(text: string) {
    try {
      if (new TextEncoder().encode(text).length > 100000)
        throw new Error(
          "Choose an export under 100 KB. Keep only the relevant task before importing.",
        );
      const next = importProcessMoments(JSON.parse(text));
      setMoments(next);
      setSelected([]);
      setInspect(next[0].id);
      setDirty(true);
      setStatus("");
      setError("");
    } catch {
      setError(
        "This export could not be read. Use 1–50 moments with unique IDs, timestamps and text, totalling at most 50 KB of context.",
      );
    }
  }
  async function save(remove = false) {
    if (!saved) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const context: RawProcessContext | null = remove
        ? null
        : {
            label: label.trim(),
            source: "deepshelves",
            kind: "sampled_screen_context",
            moments: moments.filter((m) => selected.includes(m.id)),
          };
      const result = await api<ProcessContextRecord>(endpoint, "PUT", {
        expected_revision: saved.revision,
        context,
      });
      adopt(result);
      setStatus(
        remove
          ? "Context removed. Your workflow is unchanged."
          : "Context saved for the next review. Your workflow is unchanged.",
      );
      try {
        await onSaved();
      } catch {
        setError(
          "Context was saved, but the board could not refresh. Reload the board before starting a review.",
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const active = moments.find((m) => m.id === inspect);
  return (
    <dialog
      ref={dialog}
      className="modal process-context-dialog"
      aria-labelledby="process-context-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="context-header">
        <div>
          <span className="context-eyebrow">OPTIONAL INPUT · WHITEBOARD</span>
          <h2 id="process-context-title">Show how the work happens</h2>
        </div>
        <button
          aria-label="Close process context"
          className="icon-button"
          disabled={busy}
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      <p className="context-intro">
        Add selected DeepShelves moments to help AI understand your process and
        ask better questions.
      </p>
      <div className="context-rule">
        <Monitor size={18} />
        <div>
          <strong>Observations, not instructions</strong>
          <p>
            Sampled screen text is raw process data. It may miss actions or
            exceptions. The agent uses it as context; you still approve every
            workflow change.
          </p>
        </div>
      </div>
      {locked && (
        <p className="context-lock">
          This workflow is read-only. Saved context remains available to
          inspect.
        </p>
      )}
      {!saved && !error && <p role="status">Loading saved context…</p>}
      <div className="context-body">
        <section className="context-import">
          <h3>{saved?.context ? "Recording attached" : "Bring a recording"}</h3>
          <p className="field-help">
            Import a CLI export or paste its JSON. Nothing is attached until you
            select moments and save.
          </p>
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (event) => {
              const item = event.target.files?.[0];
              event.target.value = "";
              if (!item) return;
              if (item.size > 100000) {
                setError("Choose a JSON export under 100 KB.");
                return;
              }
              try {
                preview(await item.text());
              } catch {
                setError("Unable to open this file. Try another export.");
              }
            }}
          />
          <button
            disabled={locked || busy || !saved}
            onClick={() => file.current?.click()}
          >
            <FileUp size={15} /> Import DeepShelves JSON
          </button>
          <details className="context-help">
            <summary>How to export from DeepShelves</summary>
            <p>
              Enable local CLI access in DeepShelves → Settings → Agents. From
              its app bundle, run:
            </p>
            <code>
              deepshelves-cli timeline --days 1 --limit 50 &gt; moments.json
            </code>
            <p>
              Select only the task you want to share. The CLI reads saved
              history; it does not start recording or return screenshots.
            </p>
          </details>
          <details className="context-help">
            <summary>Paste JSON instead</summary>
            <label htmlFor="process-context-json">DeepShelves JSON</label>
            <textarea
              id="process-context-json"
              value={paste}
              disabled={locked || busy}
              onChange={(event) => {
                setPaste(event.target.value);
                setDirty(true);
              }}
              rows={4}
              placeholder="Paste the timeline command’s JSON output"
            />
            <button
              disabled={locked || busy || !saved || !paste.trim()}
              onClick={() => preview(paste)}
            >
              Preview pasted moments
            </button>
          </details>
          {!!moments.length && (
            <>
              <label className="context-label" htmlFor="process-context-label">
                Recording name
              </label>
              <input
                id="process-context-label"
                maxLength={120}
                value={label}
                disabled={locked || busy}
                onChange={(event) => {
                  setLabel(event.target.value);
                  setDirty(true);
                }}
              />
              <div className="context-selection">
                <strong>
                  {selected.length} of {moments.length} selected
                </strong>
                <button
                  className="subtle"
                  disabled={locked || busy}
                  onClick={() => {
                    setSelected(
                      selected.length === moments.length
                        ? []
                        : moments.map((m) => m.id),
                    );
                    setDirty(true);
                  }}
                >
                  {" "}
                  {selected.length === moments.length
                    ? "Deselect all"
                    : "Select all"}
                </button>
              </div>
              <div className="context-moments" aria-label="Recorded moments">
                {moments.map((moment) => (
                  <div
                    className={`context-moment ${inspect === moment.id ? "selected" : ""}`}
                    key={moment.id}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Include ${moment.title}`}
                      checked={selected.includes(moment.id)}
                      disabled={locked || busy}
                      onChange={(event) => {
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, moment.id]
                            : current.filter((id) => id !== moment.id),
                        );
                        setDirty(true);
                      }}
                    />
                    <button
                      aria-pressed={inspect === moment.id}
                      onClick={() => setInspect(moment.id)}
                    >
                      <span>
                        {moment.application} ·{" "}
                        {new Date(moment.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <strong>{moment.title || "Untitled moment"}</strong>
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
        <section
          className="context-preview"
          aria-label="Raw process data preview"
        >
          <span className="context-eyebrow">WHAT THE AGENT RECEIVES</span>
          {active ? (
            <>
              <h3>{active.title || "Untitled moment"}</h3>
              <p className="field-help">
                {active.application} ·{" "}
                {new Date(active.timestamp).toLocaleString()}
              </p>
              <pre>{active.text || "No screen text captured."}</pre>
              <p className="field-help">Moment ID: {active.id}</p>
            </>
          ) : (
            <div className="context-empty">
              <FileUp size={28} />
              <h3>Review before you include</h3>
              <p>
                App names, timestamps and visible screen text appear here.
                Choose only moments relevant to this process.
              </p>
            </div>
          )}
          <p className="context-disclosure">
            Saving stores selected text with this workflow. Starting AI review
            or replying to an AI finding sends saved context to the configured
            model provider. Screenshots and separate URL fields are excluded;
            visible text can still contain sensitive information.
          </p>
        </section>
      </div>
      {error && (
        <div role="alert" className="error-banner">
          {error}
          <button
            disabled={busy}
            onClick={() => {
              if (dirty) setConfirmation("reload");
              else void reloadSaved();
            }}
          >
            Reload saved context
          </button>
        </div>
      )}
      {status && (
        <p role="status" className="context-success">
          <Check size={14} />
          {status}
        </p>
      )}
      {confirmation && (
        <section
          className="context-confirm"
          aria-label="Confirm context change"
        >
          <p>
            {confirmation === "remove"
              ? "Remove this context from future reviews? Earlier review evidence is retained."
              : confirmation === "close"
                ? "Discard your unsaved context changes?"
                : "Replace your unsaved selection with saved context?"}
          </p>
          <div className="button-row">
            <button ref={confirmButton} onClick={() => setConfirmation(null)}>
              Keep editing
            </button>
            <button
              onClick={() => {
                const action = confirmation;
                setConfirmation(null);
                if (action === "close") onClose();
                else if (action === "remove") void save(true);
                else void reloadSaved();
              }}
            >
              {confirmation === "remove"
                ? "Confirm removal"
                : confirmation === "close"
                  ? "Discard changes"
                  : "Replace with saved context"}
            </button>
          </div>
        </section>
      )}
      <div className="context-footer">
        <span className="field-help">
          {dirty
            ? "Unsaved context changes"
            : saved?.context
              ? "Included in the next review"
              : "No context attached. The usual review works without it."}
        </span>
        <div className="button-row">
          {saved?.context && (
            <button
              disabled={locked || busy}
              onClick={() => setConfirmation("remove")}
            >
              Remove context
            </button>
          )}
          <button
            className="primary"
            disabled={
              locked ||
              busy ||
              !saved ||
              !selected.length ||
              !label.trim() ||
              !dirty
            }
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save selected context"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
