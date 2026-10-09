import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { startProcessRevision } from "@/domain/process-revision";
import { ProcessRevisionService } from "@/server/process-revisions/service";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () =>
    new ProcessRevisionService(await getDatabase()).start(
      parseId((await params).id),
      await body(request, startProcessRevision),
    ),
  );
}
