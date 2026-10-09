import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { ScaffoldApplyService } from "@/server/scoping/apply-service";
import { scopingApply } from "@/domain/scoping";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () =>
    new ScaffoldApplyService(await getDatabase()).apply(
      parseId((await params).id),
      await body(request, scopingApply),
    ),
  );
}
