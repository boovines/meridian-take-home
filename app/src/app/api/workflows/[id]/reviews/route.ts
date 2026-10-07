import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { ReviewService } from "@/server/reviews/review-service";
import { dispatchReview } from "@/server/reviews/dispatch";
import { publicReview } from "@/server/reviews/public-review";
import { reviewStart } from "@/domain/review";
type Context = { params: Promise<{ id: string }> };
export async function GET(_: Request, { params }: Context) {
  return respond(async () =>
    new ReviewService(await getDatabase()).state(parseId((await params).id)),
  );
}
export async function POST(request: Request, { params }: Context) {
  return respond(
    async () =>
      publicReview(
        await dispatchReview(
          await new ReviewService(await getDatabase()).start(
            parseId((await params).id),
            await body(request, reviewStart),
          ),
        ),
      ),
    202,
  );
}
