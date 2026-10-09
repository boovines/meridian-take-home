import { DomainError } from "../../domain/errors";
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
        steps: state.spec.board.nodes.map((node) => ({
          node_id: node.id,
          method: ["human_handoff", "human_approval"].includes(node.type)
            ? ("human" as const)
            : node.type === "information"
              ? ("agent" as const)
              : ("code" as const),
          reason:
            "Fixture: information steps use Agent, required human steps stay Human, and other steps use Code.",
        })),
      }
    : await recommendMethods(state.spec.board, signal);
  return service.recommendations(workflowId, planId, revision, suggestions);
}
