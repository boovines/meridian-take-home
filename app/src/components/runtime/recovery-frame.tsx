import type { RecoveryFrameProps } from "./recovery-frame.types";
export function RecoveryFrame({
  title,
  summary,
  stage,
  count,
  actions,
  children,
}: RecoveryFrameProps) {
  return (
    <section
      className="recovery-frame recovery-timeline"
      aria-label="Run recovery"
    >
      <header>
        <div>
          <span className="eyebrow">{count}</span>
          <h3>{title}</h3>
        </div>
        {actions}
      </header>
      <p>{summary}</p>
      <div className="recovery-stage" role="status">
        <span aria-hidden="true">●</span>
        {stage}
      </div>
      {children}
    </section>
  );
}
