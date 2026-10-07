import { parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { RunService } from "@/server/runtime/run-service";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new RunService(await getDatabase()).state(
      parseId(p.id),
      parseId(p.runId),
    );
  });
}
