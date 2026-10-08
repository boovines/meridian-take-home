type Trace = Record<string, unknown>;
type Value = { present: boolean; value?: unknown };
type Change = {
  case_id: unknown;
  node_id: unknown;
  node_visit_number: unknown;
  earlier_occurrence_id: unknown;
  current_occurrence_id: unknown;
  path: (string | number)[];
  earlier: unknown;
  current: unknown;
};

function key(trace: Trace) {
  if (typeof trace.case_id !== "string" || typeof trace.node_id !== "string" ||
      typeof trace.node_visit_number !== "number" || trace.status !== "completed")
    return null;
  return JSON.stringify([trace.case_id, trace.node_id, trace.node_visit_number]);
}

function valuePreview(value: Value) {
  if (!value.present) return { present: false };
  const json = JSON.stringify(value.value ?? null);
  const bytes = Buffer.byteLength(json);
  return bytes <= 1024 ? value : {
    present: true, truncated: true, original_bytes: bytes,
    json_preview: Buffer.from(json).subarray(0, 1024).toString("utf8"),
  };
}

// Diagnostic comparison only: array positions are not inferred business identities,
// and a value from an earlier passing run is not a trusted expected answer.
export function repetitionDifferences(current: Trace[], earlier: Trace[]) {
  const currentByKey = new Map<string, Trace | null>();
  for (const trace of current) {
    const id = key(trace);
    if (id) currentByKey.set(id, currentByKey.has(id) ? null : trace);
  }
  const earlierCounts = new Map<string, number>();
  for (const trace of earlier) {
    const id = key(trace);
    if (id) earlierCounts.set(id, (earlierCounts.get(id) ?? 0) + 1);
  }
  const changes: Change[] = [];
  let compared = 0, unpaired = 0, omitted = 0, visited = 0, bytes = 0;
  let traversalLimited = false;
  outer: for (const prior of earlier) {
    const id = key(prior), next = id ? currentByKey.get(id) : null;
    if (!next || earlierCounts.get(id!) !== 1) { unpaired++; continue; }
    compared++;
    const pending: { path: (string | number)[]; a: Value; b: Value }[] = [{
      path: [], a: { present: true, value: prior.output_data },
      b: { present: true, value: next.output_data },
    }];
    while (pending.length) {
      if (++visited > 50000) { traversalLimited = true; break outer; }
      const { path, a, b } = pending.pop()!;
      if (a.present === b.present && Object.is(a.value, b.value)) continue;
      if (a.present && b.present && a.value && b.value &&
          typeof a.value === "object" && typeof b.value === "object" &&
          Array.isArray(a.value) === Array.isArray(b.value)) {
        const left = a.value as Record<string, unknown>, right = b.value as Record<string, unknown>;
        if (Array.isArray(a.value) && Math.max(a.value.length, (b.value as unknown[]).length) + pending.length > 50000) {
          traversalLimited = true; break outer;
        }
        const keys = Array.isArray(a.value)
          ? Array.from({ length: Math.max(a.value.length, (b.value as unknown[]).length) }, (_, i) => String(i))
          : [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
        if (pending.length + keys.length > 50000) { traversalLimited = true; break outer; }
        for (const child of keys.reverse()) pending.push({
          path: [...path, Array.isArray(a.value) ? Number(child) : child],
          a: { present: Object.hasOwn(left, child), value: left[child] },
          b: { present: Object.hasOwn(right, child), value: right[child] },
        });
        continue;
      }
      const change: Change = {
        case_id: next.case_id, node_id: next.node_id, node_visit_number: next.node_visit_number,
        earlier_occurrence_id: prior.occurrence_id, current_occurrence_id: next.occurrence_id,
        path, earlier: valuePreview(a), current: valuePreview(b),
      };
      const size = Buffer.byteLength(JSON.stringify(change));
      if (changes.length >= 64 || bytes + size > 16000) omitted++;
      else { changes.push(change); bytes += size; }
    }
  }
  return {
    compared_occurrences: compared,
    unpaired_or_ambiguous_occurrences: unpaired,
    changes, omitted_changes: omitted, traversal_limited: traversalLimited,
    alignment: "Completed occurrences matched by case_id, node_id and node_visit_number. JSON fields compare by key and arrays by index; reordered arrays can produce differences without a business error. Earlier/current values are observations, not expected answers. At most 64 differences/16 KB, 1024 bytes per value and 50,000 visited values per earlier run; omissions and incomplete traversal are explicit.",
  };
}
