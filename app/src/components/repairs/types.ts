import type { RepairSession, RepairAttempt } from "@/domain/repair";
export interface RepairState {
  sessions: RepairSession[];
  attempts: RepairAttempt[];
}
export interface RepairHistoryProps {
  session: RepairSession;
  attempts: RepairAttempt[];
  versionLabel: (id: string) => string;
  onInspectEvaluation: (id: string) => void;
  onInspectCode: (id: string) => void;
}
