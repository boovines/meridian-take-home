import { parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { BundleService } from "@/server/runtime/bundle-service";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; bundleId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new BundleService(await getDatabase()).read(
      parseId(p.id),
      parseId(p.bundleId),
    );
  });
}
