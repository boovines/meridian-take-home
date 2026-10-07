import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Brand } from "./brand";
import type { WorkspaceProps } from "./types";
export default function Workspace({
  title,
  subtitle,
  actions,
  children,
}: WorkspaceProps) {
  return (
    <div className="workspace workbench">
      <header className="workspace-header">
        <Brand />
        <div className="workbench-title">
          <Link href="/">Workflows</Link>
          <ChevronRight size={14} />
          <h1>{title}</h1>
        </div>
        <div className="header-actions">{actions}</div>
      </header>
      {subtitle && <div className="workbench-caption">{subtitle}</div>}
      <div className="workspace-body">{children}</div>
    </div>
  );
}
