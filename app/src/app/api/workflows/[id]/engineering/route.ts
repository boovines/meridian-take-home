import { parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { PlanService } from "@/server/engineering/plan-service";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () =>
    new PlanService(await getDatabase()).state(
      parseId((await params).id),
      new URL(request.url).searchParams.has("spec")
        ? parseId(new URL(request.url).searchParams.get("spec")!)
        : undefined,
    ),
  );
}
