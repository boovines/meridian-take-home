import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { SuiteService } from "@/server/evaluations/suite-service";
import { verifyInput } from "@/domain/evaluation";
export async function POST(
  request: Request,
  {
    params,
  }: { params: Promise<{ id: string; suiteId: string; caseId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new SuiteService(await getDatabase()).verifyCase(
      parseId(p.id),
      parseId(p.suiteId),
      parseId(p.caseId),
      await body(request, verifyInput),
    );
  });
}
