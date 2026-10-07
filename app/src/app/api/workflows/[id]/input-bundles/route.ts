import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { BundleService } from "@/server/runtime/bundle-service";
import { bundleInput } from "@/domain/runtime";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(
    async () =>
      new BundleService(await getDatabase()).create(
        parseId((await params).id),
        await body(request, bundleInput),
      ),
    201,
  );
}
