import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { PlanService } from "@/server/engineering/plan-service";
import { planStepPatch } from "@/domain/engineering";
export async function PATCH(
  request: Request,
  {
    params,
  }: { params: Promise<{ id: string; planId: string; nodeId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new PlanService(await getDatabase()).editStep(
      parseId(p.id),
      parseId(p.planId),
      parseId(p.nodeId),
      await body(request, planStepPatch),
    );
  });
}
