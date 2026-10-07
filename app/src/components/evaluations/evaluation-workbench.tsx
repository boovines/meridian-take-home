import type { WorkbenchProps } from "./types";
export function EvaluationWorkbench({
  items,
  selected,
  onSelect,
  children,
  empty,
}: WorkbenchProps) {
  return (
    <div className="evaluation-split">
      <nav aria-label="Test cases">
        {items.map((item) => (
          <button
            key={item.id}
            aria-pressed={selected === item.id}
            onClick={() => onSelect(item.id)}
          >
            <strong>{item.name}</strong>
            <small>{item.description}</small>
            <span data-result={item.status}>
              {item.status.replaceAll("_", " ")}
            </span>
          </button>
        ))}
      </nav>
      <div className="evaluation-detail-pane">
        {items.length ? children : <p>{empty}</p>}
      </div>
    </div>
  );
}
