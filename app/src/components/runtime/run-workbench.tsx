import type { ReactNode } from "react";
export interface RunWorkbenchProps {
  setup: ReactNode;
  history: ReactNode;
  result: ReactNode;
}
export function RunWorkbench({ setup, history, result }: RunWorkbenchProps) {
  return (
    <div className="run-workbench run-sidebar-grid">
      <aside>
        {setup}
        {history}
      </aside>
      {result}
    </div>
  );
}
