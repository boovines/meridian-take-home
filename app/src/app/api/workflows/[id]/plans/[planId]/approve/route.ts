import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { PlanService } from "@/server/engineering/plan-service";
import { approvePlanInput } from "@/domain/engineering";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; planId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new PlanService(await getDatabase()).approve(
      parseId(p.id),
      parseId(p.planId),
      await body(request, approvePlanInput),
    );
  });
}
