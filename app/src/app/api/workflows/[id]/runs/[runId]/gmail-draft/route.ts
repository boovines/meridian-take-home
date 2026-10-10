import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { GmailDraftService } from "@/server/gmail-drafts/service";
import { gmailDraftWriter } from "@/server/integrations/composio-gmail";
import { draftRequest } from "@/domain/gmail-drafts";
type Context = { params: Promise<{ id: string; runId: string }> };
export async function GET(_: Request, { params }: Context) {
  return respond(async () => {
    const p = await params;
    return new GmailDraftService(await getDatabase(), gmailDraftWriter()).state(
      parseId(p.id),
      parseId(p.runId),
    );
  });
}
export async function POST(request: Request, { params }: Context) {
  return respond(async () => {
    const p = await params;
    return new GmailDraftService(
      await getDatabase(),
      gmailDraftWriter(),
    ).create(
      parseId(p.id),
      parseId(p.runId),
      await body(request, draftRequest),
    );
  });
}
