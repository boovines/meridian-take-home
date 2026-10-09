import { gmailGroupingRequest } from "@/domain/gmail-grouping";
import { getDatabase } from "@/server/database";
import { body, parseId, respond } from "@/server/http";
import { gmailReader } from "@/server/integrations/composio-gmail";
import { GmailGroupingService } from "@/server/inputs/gmail-grouping";
export const runtime = "nodejs";
export const maxDuration = 180;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => new GmailGroupingService(await getDatabase(), gmailReader()).prepare(
    parseId((await context.params).id), await body(request, gmailGroupingRequest),
    AbortSignal.any([request.signal, AbortSignal.timeout(150_000)]),
  ));
}
