import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { SuiteService } from "@/server/evaluations/suite-service";
import { editCaseInput, verifyInput } from "@/domain/evaluation";
export async function PATCH(
  request: Request,
  {
    params,
  }: { params: Promise<{ id: string; suiteId: string; caseId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new SuiteService(await getDatabase()).editCase(
      parseId(p.id),
      parseId(p.suiteId),
      parseId(p.caseId),
      await body(request, editCaseInput),
    );
  });
}

export async function DELETE(
  request: Request,
  {
    params,
  }: { params: Promise<{ id: string; suiteId: string; caseId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new SuiteService(await getDatabase()).removeCase(
      parseId(p.id),
      parseId(p.suiteId),
      parseId(p.caseId),
      await body(request, verifyInput),
    );
  });
}
