import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { ReviewService } from "@/server/reviews/review-service";
import { dispatchReview } from "@/server/reviews/dispatch";
import { publicReview, requireReview } from "@/server/reviews/public-review";
import { goalAnswer } from "@/domain/review";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; reviewId: string }> },
) {
  return respond(async () => {
    const p = await params,
      id = parseId(p.id),
      reviewId = parseId(p.reviewId);
    await requireReview(id, reviewId);
    return publicReview(
      await dispatchReview(
        await new ReviewService(await getDatabase()).answerGoal(
          reviewId,
          await body(request, goalAnswer),
        ),
      ),
    );
  }, 202);
}
