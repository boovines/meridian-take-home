import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { SuiteService } from "@/server/evaluations/suite-service";
import { caseInput } from "@/domain/evaluation";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; suiteId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new SuiteService(await getDatabase()).addCase(
      parseId(p.id),
      parseId(p.suiteId),
      await body(request, caseInput),
    );
  }, 201);
}
