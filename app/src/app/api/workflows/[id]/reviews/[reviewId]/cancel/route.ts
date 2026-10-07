import { z } from "zod";
import { body, parseId, respond } from "@/server/http";
import { cancelReview } from "@/server/reviews/dispatch";
import { publicReview, requireReview } from "@/server/reviews/public-review";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; reviewId: string }> },
) {
  return respond(async () => {
    await body(request, z.object({}).strict());
    const p = await params,
      id = parseId(p.id),
      reviewId = parseId(p.reviewId);
    await requireReview(id, reviewId);
    return publicReview(await cancelReview(reviewId));
  });
}
