import { scopeReady, type Scope } from "@/domain/scoping";

export function ScopeSummary({ scope }: { scope: Scope }) {
  return (
    <details className="scope-summary" open={scopeReady(scope)}>
      <summary>
        Current scope{" "}
        <span>
          {scopeReady(scope) ? "Ready to confirm" : "Draft with open questions"}
        </span>
      </summary>
      <p>{scope.summary}</p>
      <dl>
        {(
          [
            "trigger",
            "outcome",
            "steps",
            "routing",
            "humans",
            "exceptions",
          ] as const
        ).map((key) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{scope.coverage[key] || "Still to clarify"}</dd>
          </div>
        ))}
      </dl>
      {!!scope.blockers.length && (
        <>
          <strong>Resolve during workflow review</strong>
          <ul>
            {scope.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </>
      )}
      {!!scope.assumptions.length && (
        <>
          <strong>Assumptions to confirm</strong>
          <ul>
            {scope.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </>
      )}
      {!!scope.unresolved.length && (
        <>
          <strong>Details for normal review</strong>
          <ul>
            {scope.unresolved.map((u) => (
              <li key={u.key}>{u.question}</li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
