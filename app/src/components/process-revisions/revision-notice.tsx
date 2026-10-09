"use client";
import "./revisions.css";
export function RevisionNotice({
  count,
  onOpen,
}: {
  count: number;
  onOpen: () => void;
}) {
  if (!count) return null;
  return (
    <section className="revision-notice">
      <div>
        <strong>Engineer requested changes</strong>
        <p>
          {count} open request{count === 1 ? "" : "s"} · Discuss, reject, or
          start a revision.
        </p>
      </div>
      <button onClick={onOpen}>Open conversation</button>
    </section>
  );
}
