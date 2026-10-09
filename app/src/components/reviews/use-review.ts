"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewState } from "@/domain/review";
import { api, errorMessage } from "@/lib/api";
const empty: ReviewState = { runs: [], threads: [], messages: [], anchors: [] };
export function useReview(
  workflowId: string,
  onBoardChange: () => Promise<void>,
) {
  const [state, setState] = useState(empty),
    [error, setError] = useState("");
  const requestVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const next = await api<ReviewState>(`/api/workflows/${workflowId}/reviews`);
      if (version !== requestVersion.current) return;
      setState(next);
      setError("");
      await onBoardChange();
    } catch (error) {
      if (version === requestVersion.current) throw error;
    }
  }, [workflowId, onBoardChange]);
  useEffect(() => {
    let current = true;
    const version = ++requestVersion.current;
    api<ReviewState>(`/api/workflows/${workflowId}/reviews`)
      .then((s) => {
        if (current && version === requestVersion.current) setState(s);
      })
      .catch((e) => {
        if (current && version === requestVersion.current) setError(errorMessage(e));
      });
    return () => {
      current = false;
    };
  }, [workflowId]);
  const active = state.runs.find((r) =>
    ["queued", "running", "awaiting_customer"].includes(r.status),
  );
  const activeId=active?.id;
  useEffect(() => {
    if (!activeId) return;
    const timer = setInterval(() => {
      void refresh().catch((e) => setError(errorMessage(e)));
    }, 2500);
    return () => clearInterval(timer);
  }, [activeId, refresh]);
  return { state, error, refresh, active };
}
