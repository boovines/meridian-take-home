import { z } from "zod";
import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { GmailDraftService } from "@/server/gmail-drafts/service";
import { gmailDraftWriter } from "@/server/integrations/composio-gmail";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    const { enabled } = await body(
      request,
      z.object({ enabled: z.boolean() }).strict(),
    );
    return new GmailDraftService(
      await getDatabase(),
      gmailDraftWriter(),
    ).configure(parseId((await params).id), enabled);
  });
}
