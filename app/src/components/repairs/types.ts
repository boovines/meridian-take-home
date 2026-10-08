import type { RepairSession, RepairAttempt, RepairConfirmation } from "@/domain/repair";
export interface RepairState {
  sessions: RepairSession[];
  attempts: RepairAttempt[];
  confirmations: RepairConfirmation[];
}
export interface RepairHistoryProps {
  session: RepairSession;
  attempts: RepairAttempt[];
  confirmations: RepairConfirmation[];
  versionLabel: (id: string) => string;
  onInspectEvaluation: (id: string) => void;
  onInspectCode: (id: string) => void;
}
