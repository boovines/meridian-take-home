import type { GroupWorkbenchProps } from "./group-workbench.types";
export function GroupWorkbench({
  setup,
  history,
  summary,
  groups,
  inspection,
  hasHistory,
}: GroupWorkbenchProps) {
  return (
    <div className="group-workbench">
      {summary}
      <div className="group-control-row">
        <details key={hasHistory ? "history" : "empty"} open={!hasHistory}>
          <summary>Start a new email run</summary>
          {setup}
        </details>
        <details>
          <summary>Browse recent runs</summary>
          {history}
        </details>
      </div>
      <div className="group-results-split">
        {groups}
        {inspection}
      </div>
    </div>
  );
}
