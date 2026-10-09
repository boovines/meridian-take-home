import { diffWordsWithSpace } from "diff";
export function InstructionDiff({
  before,
  after,
}: {
  before: string;
  after: string;
}) {
  const parts = diffWordsWithSpace(before, after, {
    timeout: 30,
    maxEditLength: 1500,
  }) || [
    { value: before, removed: true, added: false },
    { value: after, added: true, removed: false },
  ];
  return (
    <div className="instruction-diff">
      <div className="diff-legend">
        <span>− Removed</span>
        <span>+ Added</span>
      </div>
      <p>
        {parts.map((part, i) =>
          part.added ? (
            <ins key={i}>
              <span className="sr-only">Added: </span>
              {part.value}
            </ins>
          ) : part.removed ? (
            <del key={i}>
              <span className="sr-only">Removed: </span>
              {part.value}
            </del>
          ) : (
            <span key={i}>{part.value}</span>
          ),
        )}
      </p>
    </div>
  );
}
