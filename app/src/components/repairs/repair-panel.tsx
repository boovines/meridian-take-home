"use client";
import { useCallback, useEffect, useState } from "react";
import type { ImplementationVersion } from "@/domain/engineering";
import { api, errorMessage } from "@/lib/api";
import type { RepairState } from "./types";
import { RepairHistory } from "./repair-history";
import "./repairs.css";
export function RepairPanel({
  workflowId,
  versions,
  operationActive,
  onInspectEvaluation,
  onInspectCode,
}: {
  workflowId: string;
  versions: ImplementationVersion[];
  operationActive: boolean;
  onInspectEvaluation: (id: string) => void;
  onInspectCode: (id: string) => void;
}) {
  const [state, setState] = useState<RepairState | null>(null),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<RepairState | null>(null),
    [error, setError] = useState("");
  const base = `/api/workflows/${workflowId}/repairs`;
  const load = useCallback(async () => {
    const history = await api<RepairState>(base);
    const current = selected
      ? await api<RepairState>(`${base}/${selected}`)
      : history;
    return { history, current };
  }, [base, selected]);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void load()
        .then(({ history, current }) => {
          if (active) {
            setState(history);
            setDetail(current);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(errorMessage(e));
        });
    refresh();
    const timer = operationActive ? setInterval(refresh, 2500) : null;
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [load, operationActive]);
  if (error)
    return (
      <p role="alert" className="error-banner">
        {error}
      </p>
    );
  if (!state) return <p role="status">Loading repair history…</p>;
  const session = detail?.sessions[0];
  if (!session)
    return (
      <div className="engineer-empty">
        <h3>No repair sessions yet.</h3>
        <p>
          Inspect a failed evaluation, then choose Repair and rerun. Each
          session preserves its starting code, approved methods, and verified
          suite.
        </p>
      </div>
    );
  return (
    <div className="repair-panel">
      <label className="repair-session-select">
        Repair session
        <select
          value={session.id}
          onChange={(e) => setSelected(e.target.value)}
        >
          {state.sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {new Date(s.created_at).toLocaleString()} ·{" "}
              {s.status.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      <RepairHistory
        session={session}
        attempts={detail!.attempts}
        versionLabel={(id) => {
          const v = versions.find((v) => v.id === id);
          return v ? `v${v.version_number}` : "Earlier code";
        }}
        onInspectEvaluation={onInspectEvaluation}
        onInspectCode={onInspectCode}
      />
    </div>
  );
}
