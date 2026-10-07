import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { SuiteService } from "@/server/evaluations/suite-service";
import { verifyInput } from "@/domain/evaluation";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; suiteId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new SuiteService(await getDatabase()).lock(
      parseId(p.id),
      parseId(p.suiteId),
      await body(request, verifyInput),
    );
  });
}
