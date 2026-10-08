import { parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { ExecutionAuditService } from "@/server/runtime/audit-service";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new ExecutionAuditService(await getDatabase()).read(
      parseId(p.id),
      parseId(p.eventId),
    );
  });
}
