import { DomainError } from "../../domain/canvas";
import type { Database } from "../database";
import { recommendMethods } from "../integrations/openai-engineer";
import { fixtureEngineering } from "./dispatch";
import { PlanService } from "./plan-service";
export async function suggestPlanMethods(
  db: Database,
  workflowId: string,
  planId: string,
  revision: number,
  signal: AbortSignal,
) {
  const service = new PlanService(db),
    state = await service.state(workflowId),
    plan = state.plans.find((p) => p.id === planId);
  if (!plan || plan.state !== "draft" || plan.revision !== revision)
    throw new DomainError(
      409,
      "PLAN_CHANGED",
      "Reload the current draft before requesting suggestions.",
    );
  const suggestions = fixtureEngineering()
    ? {
        steps: state.steps
          .filter((s) => s.plan_version_id === planId)
          .map((s) => ({
            node_id: s.node_id,
            method: s.selected_method,
            reason: "Fixture: this choice matches the frozen requirements.",
          })),
      }
    : await recommendMethods(state.spec.board, signal);
  return service.recommendations(workflowId, planId, revision, suggestions);
}
