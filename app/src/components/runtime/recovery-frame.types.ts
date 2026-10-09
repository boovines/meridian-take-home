import type { ReactNode } from "react";
export interface RecoveryFrameProps {
  title: string;
  summary: string;
  stage: string;
  count: string;
  actions?: ReactNode;
  children: ReactNode;
}
