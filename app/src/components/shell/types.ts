import type { ReactNode } from "react";
export interface WorkspaceProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}
