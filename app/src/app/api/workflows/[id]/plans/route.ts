import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { PlanService } from "@/server/engineering/plan-service";
import { createPlanInput } from "@/domain/engineering";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(
    async () =>
      new PlanService(await getDatabase()).create(
        parseId((await params).id),
        await body(request, createPlanInput),
      ),
    201,
  );
}
