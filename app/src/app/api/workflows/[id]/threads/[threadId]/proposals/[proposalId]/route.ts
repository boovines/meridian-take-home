import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { replyProposalDecision } from "@/domain/review-reply";
import { ReplyProposalService } from "@/server/reviews/reply-proposal-service";
export async function POST(
  request: Request,
  {
    params,
  }: { params: Promise<{ id: string; threadId: string; proposalId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new ReplyProposalService(await getDatabase()).decide(
      parseId(p.id),
      parseId(p.threadId),
      parseId(p.proposalId),
      await body(request, replyProposalDecision),
    );
  });
}
