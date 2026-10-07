import { parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { RepairService } from "@/server/repairs/service";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; sessionId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new RepairService(await getDatabase()).state(
      parseId(p.id),
      parseId(p.sessionId),
    );
  });
}
