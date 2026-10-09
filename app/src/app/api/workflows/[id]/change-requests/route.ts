import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { requestProcessChange } from "@/domain/process-revision";
import { ProcessRevisionService } from "@/server/process-revisions/service";
import { ReviewService } from "@/server/reviews/review-service";
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () =>
    (
      await new ReviewService(await getDatabase()).state(
        parseId((await params).id),
      )
    ).threads.filter((t) => t.engineer_request),
  );
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(
    async () =>
      new ProcessRevisionService(await getDatabase()).request(
        parseId((await params).id),
        await body(request, requestProcessChange),
      ),
    201,
  );
}
