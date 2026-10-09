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
      !Number.isSafeInteger(trace.node_visit_number) || trace.status !== "completed")
    return null;
  return JSON.stringify([trace.case_id, trace.node_id, trace.node_visit_number]);
}

function valuePreview(value: Value) {
  if (!value.present) return { present: false };
  // Type changes/additions can contain arbitrarily large subtrees. Do not
  // serialize them just to discard all but a preview.
  if (value.value && typeof value.value === "object") return {
    present: true, truncated: true, preview_omitted: "structured_value",
    type: Array.isArray(value.value) ? "array" : "object",
  };
  if (typeof value.value === "string" && value.value.length > 4096) return {
    present: true, truncated: true, original_code_units: value.value.length,
    string_prefix: value.value.slice(0, 128),
  };
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
  const paired = (trace: Trace) => {
    const id = key(trace);
    return id !== null && earlierCounts.get(id) === 1 && !!currentByKey.get(id);
  };
  const pairs = earlier.filter(paired);
  const unpairedEarlier = earlier.length - pairs.length;
  const unpairedCurrent = current.filter(trace => !paired(trace)).length;
  let compared = 0, completed = 0, omitted = 0, visited = 0, queued = 0, bytes = 2, keyCharacters = 0;
  let traversalLimited = false;
  outer: for (const prior of pairs) {
    const next = currentByKey.get(key(prior)!)!;
    compared++;
    queued++;
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
        if (path.length >= 64) { traversalLimited = true; break outer; }
        const keys: string[] = [], seen = new Set<string>();
        // Charge keys before allocating child paths. A lifetime queue limit
        // prevents a deep/wide tree from repeatedly filling the pending stack.
        for (const object of [left, right]) {
          for (const child in object) {
            if (!Object.hasOwn(object, child) || seen.has(child)) continue;
            if (++queued > 50000 || (keyCharacters += child.length) > 1000000) {
              traversalLimited = true; break outer;
            }
            seen.add(child); keys.push(child);
          }
        }
        keys.sort((x, y) => Array.isArray(a.value) ? Number(x) - Number(y) : x < y ? -1 : x > y ? 1 : 0);
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
      const size = Buffer.byteLength(JSON.stringify(change)) + (changes.length ? 1 : 0);
      if (changes.length >= 64 || bytes + size > 16000) omitted++;
      else { changes.push(change); bytes += size; }
    }
    completed++;
  }
  return {
    completed_comparisons: completed,
    unvisited_paired_occurrences: pairs.length - compared,
    compared_occurrences: compared,
    unpaired_or_ambiguous_occurrences: unpairedEarlier + unpairedCurrent,
    unpaired_earlier_occurrences: unpairedEarlier,
    unpaired_current_occurrences: unpairedCurrent,
    changes, omitted_changes: omitted, traversal_limited: traversalLimited,
    alignment: "Completed occurrences matched by case_id, node_id and node_visit_number. JSON fields compare by key and arrays by index; reordered arrays can produce differences without a business error. Earlier/current values are observations, not expected answers. At most 64 differences/16 KB, 1024 bytes per scalar preview, 50,000 queued/visited values, 64 path segments and one million key characters per earlier run. Structured additions/type changes omit value previews; long strings report a prefix. Coverage is for supplied traces only; compared occurrences include a possibly partial final comparison, completed_comparisons excludes it. Omissions and incomplete traversal are explicit.",
  };
}
