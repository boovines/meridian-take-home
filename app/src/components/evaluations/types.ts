import type { ReactNode } from "react";
import type {
  EvaluationCase,
  EvaluationRun,
  CaseResult,
  SuiteVersion,
} from "@/domain/evaluation";
export interface SuiteState {
  selected_suite_id: string | null;
  suites: SuiteVersion[];
  cases: EvaluationCase[];
}
export interface EvaluationState {
  runs: EvaluationRun[];
  results: CaseResult[];
}
export interface BundleSummary {
  id: string;
  shipment_reference: string | null;
  source_kind: string;
  created_at: string;
}
export interface WorkbenchProps {
  items: { id: string; name: string; description: string; status: string }[];
  selected: string;
  onSelect: (id: string) => void;
  children: ReactNode;
  empty: string;
}
