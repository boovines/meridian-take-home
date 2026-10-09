import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { resolveProcessRequest } from "@/domain/process-revision";
import { ProcessRevisionService } from "@/server/process-revisions/service";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; threadId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new ProcessRevisionService(await getDatabase()).resolve(
      parseId(p.id),
      parseId(p.threadId),
      await body(request, resolveProcessRequest),
    );
  });
}
