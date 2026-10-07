import { parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { VersionService } from "@/server/engineering/version-service";
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new VersionService(await getDatabase()).inspect(
      parseId(p.id),
      parseId(p.versionId),
    );
  });
}
