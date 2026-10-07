import { parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { PlanService } from "@/server/engineering/plan-service";
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () =>
    new PlanService(await getDatabase()).state(parseId((await params).id)),
  );
}
