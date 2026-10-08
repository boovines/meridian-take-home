import { z } from "zod";
import { parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { ExecutionAuditService } from "@/server/runtime/audit-service";
const owner = z.union([
  z.object({ step_execution_id: z.uuid() }).strict(),
  z.object({ case_result_id: z.uuid() }).strict(),
]);
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => ({
    events: await new ExecutionAuditService(await getDatabase()).list(
      parseId((await params).id),
      owner.parse(Object.fromEntries(new URL(request.url).searchParams)),
    ),
  }));
}
