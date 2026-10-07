import { gmailSearch } from "@/domain/gmail";
import { getDatabase } from "@/server/database";
import { respond, parseId } from "@/server/http";
import { gmailReader } from "@/server/integrations/composio-gmail";
import { workflow } from "@/server/workflows/store";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    const id = parseId((await context.params).id);
    await workflow(await getDatabase(), id);
    const search = gmailSearch.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    return gmailReader().search(
      search.query,
      search.page_token,
      AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
    );
  });
}
