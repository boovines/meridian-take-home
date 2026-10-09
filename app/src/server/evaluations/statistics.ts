import {
  evaluationStatistics,
  type EvaluationStatistics,
  type StatisticsCase,
} from "../../domain/evaluation-statistics";
import type { Queryable } from "../database";

/** Project only grades for the requested runs, never historical actual outputs or traces. */
export async function statisticsByEvaluation(db: Queryable, runIds: string[]) {
  if (!runIds.length) return {};
  const rows = (
    await db.query(
      `
    SELECT e.id AS evaluation_id,
      (SELECT jsonb_agg(a->>'key') FROM jsonb_array_elements(c.assertions) a) AS assertion_keys,
      r.status, r.outcome,
      coalesce((SELECT jsonb_agg(jsonb_build_object('key',g->>'key','passed',g->'passed'))
        FROM jsonb_array_elements(r.check_results) g), '[]'::jsonb) AS checks
    FROM evaluation_runs e
    JOIN evaluation_cases c ON c.suite_version_id=e.suite_version_id
    LEFT JOIN evaluation_case_results r ON r.evaluation_run_id=e.id AND r.case_id=c.id
    WHERE e.id=ANY($1::uuid[])
  `,
      [runIds],
    )
  ).rows as unknown as (StatisticsCase & { evaluation_id: string })[];
  const grouped = new Map<string, StatisticsCase[]>();
  for (const row of rows) {
    const group = grouped.get(row.evaluation_id) || [];
    group.push(row);
    grouped.set(row.evaluation_id, group);
  }
  return Object.fromEntries(
    runIds.map((id) => [id, evaluationStatistics(grouped.get(id) || [])]),
  ) as Record<string, EvaluationStatistics>;
}
