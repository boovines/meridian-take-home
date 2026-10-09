import { parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { GroupedExecutionService } from "@/server/grouped-execution/service";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  return respond(async () => {
    const { id, jobId } = await params;
    return new GroupedExecutionService(await getDatabase()).read(
      parseId(id),
      parseId(jobId),
    );
  });
}
