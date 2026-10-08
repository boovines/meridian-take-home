"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { SuiteState, EvaluationState, BundleSummary } from "./types";

/** Load workspace projections and the exact suite for a selected historical run. */
export function useEvaluationData(
  base: string,
  suiteId: string,
  runId: string,
  operationActive: boolean,
) {
  const [suites, setSuites] = useState<SuiteState | null>(null);
  const [history, setHistory] = useState<EvaluationState | null>(null);
  const [bundles, setBundles] = useState<BundleSummary[]>([]);
  const [runDetail, setRunDetail] = useState<EvaluationState | null>(null);
  const [runCases, setRunCases] = useState<SuiteState | null>(null);
  const [error, setError] = useState("");
  const fetchState = useCallback(
    () =>
      Promise.all([
        api<SuiteState>(`${base}/suites${suiteId ? `?suite=${suiteId}` : ""}`),
        api<EvaluationState>(`${base}/evaluations`),
        api<BundleSummary[]>(`${base}/input-bundles`),
      ]),
    [base, suiteId],
  );
  const load = useCallback(async () => {
    const [s, h, b] = await fetchState();
    setSuites(s);
    setHistory(h);
    setBundles(b);
  }, [fetchState]);
  useEffect(() => {
    let active = true;
    fetchState()
      .then(([s, h, b]) => {
        if (active) {
          setSuites(s);
          setHistory(h);
          setBundles(b);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [fetchState, operationActive]);
  useEffect(() => {
    if (!operationActive) return;
    const t = setInterval(
      () => void load().catch((e) => setError(errorMessage(e))),
      2500,
    );
    return () => clearInterval(t);
  }, [load, operationActive]);
  const selectedRunId = runId || history?.runs[0]?.id;
  const currentRun =
    history?.runs.find((r) => r.id === selectedRunId) ||
    (runDetail && runDetail.runs[0]?.id === selectedRunId
      ? runDetail.runs[0]
      : undefined);
  useEffect(() => {
    if (!selectedRunId) return;
    let active = true;
    api<EvaluationState>(`${base}/evaluations/${selectedRunId}`)
      .then(async (d) => {
        const s = await api<SuiteState>(
          `${base}/suites?suite=${d.runs[0].suite_version_id}`,
        );
        if (active) {
          setRunDetail(d);
          setRunCases(s);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [base, selectedRunId, history]);
  return {
    suites,
    history,
    bundles,
    runDetail,
    runCases,
    selectedRunId,
    currentRun,
    load,
    error,
    setError,
  };
}
