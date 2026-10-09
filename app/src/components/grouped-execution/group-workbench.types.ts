import type { ReactNode } from "react";
export interface GroupWorkbenchProps {
  hasHistory: boolean;
  setup: ReactNode;
  history: ReactNode;
  summary: ReactNode;
  groups: ReactNode;
  inspection: ReactNode;
}
