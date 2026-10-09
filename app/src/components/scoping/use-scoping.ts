"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { ScopingState, ScopingSession } from "@/domain/scoping";
import type { Board } from "@/domain/canvas";
export function useScoping(workflowId: string, locked: boolean) {
  const [state, setState] = useState<ScopingState | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ScopingSession | null>(null);
  const [recovered, setRecovered] = useState(false);
  const stateRef = useRef<ScopingState | null>(null);
  const noteRef = useRef("");
  const saved = useRef<{ note: string; revision: number } | null>(null);
  const savePromise = useRef<Promise<void> | null>(null);
  const blocked = useRef(false);
  const initialized = useRef(false);
  const localKey = `meridian-scoping-draft:${workflowId}`;
  const ingest = useCallback((next: ScopingState) => {
    const current = stateRef.current;
    if (
      current &&
      (next.session.revision < current.session.revision ||
        next.session.note_revision < current.session.note_revision)
    )
      return;
    stateRef.current = next;
    setState(next);
  }, []);
  const refresh = useCallback(async () => {
    const next = await api<ScopingState>(
      `/api/workflows/${workflowId}/scoping`,
    );
    ingest(next);
    if (!initialized.current) {
      initialized.current = true;
      saved.current = {
        note: next.session.note,
        revision: next.session.note_revision,
      };
      let draft: string | null = null;
      try {
        draft = localStorage.getItem(localKey);
      } catch {
        /* Browser storage may be disabled. */
      }
      const text = draft ?? next.session.note;
      noteRef.current = text;
      setNote(text);
      if (draft !== null && draft !== next.session.note) {
        blocked.current = true;
        setRecovered(true);
        setConflict(next.session);
      }
    }
    return next;
  }, [workflowId, ingest, localKey]);
  useEffect(() => {
    void refresh().catch((e) => setError(errorMessage(e)));
  }, [refresh, locked]);
  const active =
    state?.operation && ["queued", "running"].includes(state.operation.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => void refresh().catch((e) => setError(errorMessage(e))),
      2000,
    );
    return () => clearInterval(timer);
  }, [active, refresh]);
  const changeNote = useCallback(
    (text: string) => {
      noteRef.current = text;
      setNote(text);
      try {
        localStorage.setItem(localKey, text);
      } catch {
        /* beforeunload still warns for unsaved text. */
      }
    },
    [localKey],
  );
  const flush = useCallback(async () => {
    if (savePromise.current) await savePromise.current;
    if (!saved.current || noteRef.current === saved.current.note) return;
    if (blocked.current || locked)
      throw new Error(
        "Resolve the note conflict or wait until the board is editable before sending.",
      );
    const save = async () => {
      setSaving(true);
      try {
        while (saved.current && noteRef.current !== saved.current.note) {
          const text = noteRef.current;
          const next = await api<ScopingSession>(
            `/api/workflows/${workflowId}/scoping`,
            "PATCH",
            { note: text, expected_revision: saved.current.revision },
          );
          saved.current = { note: next.note, revision: next.note_revision };
          if (stateRef.current) ingest({ ...stateRef.current, session: next });
          if (noteRef.current === text)
            try {
              localStorage.removeItem(localKey);
            } catch {
              /* optional recovery storage */
            }
        }
        setError("");
      } catch (e) {
        blocked.current = true;
        setError(errorMessage(e));
        if (e instanceof ApiError && e.code === "NOTE_CONFLICT")
          setConflict((e.details as { current: ScopingSession }).current);
        throw e;
      } finally {
        setSaving(false);
      }
    };
    savePromise.current = save();
    try {
      await savePromise.current;
    } finally {
      savePromise.current = null;
    }
  }, [workflowId, ingest, localKey, locked]);
  useEffect(() => {
    if (
      !state ||
      conflict ||
      recovered ||
      locked ||
      note === saved.current?.note
    )
      return;
    const timer = setTimeout(() => void flush().catch(() => {}), 750);
    return () => clearTimeout(timer);
  }, [note, state, conflict, recovered, locked, flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saved.current && noteRef.current !== saved.current.note)
        e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  async function recover(keepMine: boolean) {
    if (!conflict) return;
    saved.current = { note: conflict.note, revision: conflict.note_revision };
    if (stateRef.current)
      ingest({
        ...stateRef.current,
        session: {
          ...stateRef.current.session,
          note: conflict.note,
          note_revision: conflict.note_revision,
        },
      });
    if (!keepMine) {
      noteRef.current = conflict.note;
      setNote(conflict.note);
      try {
        localStorage.removeItem(localKey);
      } catch {}
    }
    blocked.current = false;
    setConflict(null);
    setRecovered(false);
    setError("");
    if (keepMine) await flush().catch(() => {});
  }
  async function request(
    action: "start" | "answer" | "notes" | "revise" | "preview",
    body = "",
  ) {
    setBusy(true);
    setError("");
    try {
      await flush();
      const s = stateRef.current!.session;
      const next = await api<ScopingState>(
        `/api/workflows/${workflowId}/scoping/requests`,
        "POST",
        {
          action,
          body,
          expected_revision: s.revision,
          expected_note_revision: s.note_revision,
          request_key: crypto.randomUUID(),
        },
      );
      ingest(next);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      await refresh().catch(() => {});
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function apply(board: Board, onApplied: (b: Board) => void) {
    setBusy(true);
    setError("");
    const previewId = stateRef.current?.session.current_preview_id;
    try {
      await flush();
      const s = stateRef.current!.session;
      const result = await api<Board>(
        `/api/workflows/${workflowId}/scoping/apply`,
        "POST",
        {
          preview_id: s.current_preview_id,
          expected_revision: s.revision,
          expected_workflow_revision: board.workflow.revision,
          request_key: crypto.randomUUID(),
        },
      );
      onApplied(result);
      await refresh();
      return true;
    } catch (e) {
      const recovered = await refresh().catch(() => null);
      if (previewId && recovered?.session.applied_preview_id === previewId) {
        const savedBoard = await api<Board>(
          `/api/workflows/${workflowId}`,
        ).catch(() => null);
        if (savedBoard) {
          onApplied(savedBoard);
          setError("");
          return true;
        }
      }
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!stateRef.current?.operation) return;
    setBusy(true);
    try {
      ingest(
        await api<ScopingState>(
          `/api/workflows/${workflowId}/scoping/cancel`,
          "POST",
          { operation_id: stateRef.current.operation.id },
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return {
    state,
    note,
    error,
    saving,
    busy,
    conflict,
    recovered,
    active: !!active,
    changeNote,
    flush,
    refresh,
    request,
    apply,
    cancel,
    recover,
    dirty: note !== state?.session.note,
    retrySave: async () => {
      blocked.current = false;
      await flush().catch(() => {});
    },
  };
}
export type ScopingController = ReturnType<typeof useScoping>;
