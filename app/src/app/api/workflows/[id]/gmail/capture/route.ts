import { gmailCapture } from "@/domain/gmail";
import { getDatabase } from "@/server/database";
import { respond, parseId, body } from "@/server/http";
import { gmailReader } from "@/server/integrations/composio-gmail";
import { GmailCaptureService } from "@/server/inputs/gmail-capture";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return respond(
    async () =>
      new GmailCaptureService(await getDatabase(), gmailReader()).capture(
        parseId((await context.params).id),
        await body(request, gmailCapture),
        AbortSignal.any([request.signal, AbortSignal.timeout(240_000)]),
      ),
    201,
  );
}
