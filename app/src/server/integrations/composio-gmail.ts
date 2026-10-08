import { z } from "zod";
import { DomainError } from "../../domain/errors";
import type {
  GmailMessage,
  GmailReader,
  GmailSummary,
} from "../../domain/gmail";
const API = "https://backend.composio.dev";
const VERSION = "20260915_00";
const rawMessage = z.object({
  messageId: z.string(),
  threadId: z.string().default(""),
  subject: z.string().default("(No subject)"),
  sender: z.string().default(""),
  messageTimestamp: z.string().default(""),
  messageText: z.string().default(""),
  attachmentList: z
    .array(
      z.object({
        attachmentId: z.string(),
        filename: z.string(),
        mimeType: z.string(),
      }),
    )
    .default([]),
});
function summary(m: z.infer<typeof rawMessage>): GmailSummary {
  return {
    id: m.messageId,
    thread_id: m.threadId,
    subject: m.subject,
    sender: m.sender,
    received_at: m.messageTimestamp,
  };
}
export async function boundedBytes(
  response: Response,
  limit: number,
): Promise<Buffer> {
  if (!response.ok || !response.body)
    throw new DomainError(
      502,
      "GMAIL_DOWNLOAD_FAILED",
      "The attachment could not be downloaded. Retry capture.",
    );
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    throw new DomainError(
      413,
      "DOCUMENT_TOO_LARGE",
      "A document exceeds the capture size limit.",
    );
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit)
        throw new DomainError(
          413,
          "DOCUMENT_TOO_LARGE",
          "A document exceeds the capture size limit.",
        );
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}
// Only URLs issued by the observed Composio attachment store are accepted. Never follow redirects.
export function attachmentUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^temp\.[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname)
  )
    throw new DomainError(
      502,
      "GMAIL_DOWNLOAD_HOST",
      "Composio returned an unsupported attachment host.",
    );
  return url;
}
export class ComposioGmail implements GmailReader {
  private userId: string | undefined;
  constructor(
    private config: { key: string; account: string },
    private request: typeof fetch = fetch,
  ) {}
  private async json(path: string, signal: AbortSignal, data?: unknown) {
    const response = await this.request(`${API}${path}`, {
      method: data ? "POST" : "GET",
      redirect: "error",
      signal,
      headers: {
        "x-api-key": this.config.key,
        "content-type": "application/json",
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    if (!response.ok)
      throw new DomainError(
        502,
        "GMAIL_UNAVAILABLE",
        "Gmail retrieval failed. Check the Composio connection and retry.",
      );
    return JSON.parse((await boundedBytes(response, 2_000_000)).toString());
  }
  private async execute(
    tool:
      | "GMAIL_FETCH_EMAILS"
      | "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID"
      | "GMAIL_GET_ATTACHMENT",
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    if (!this.userId) {
      const account = z
        .object({ user_id: z.string().min(1), status: z.literal("ACTIVE") })
        .parse(
          await this.json(
            `/api/v3/connected_accounts/${encodeURIComponent(this.config.account)}`,
            signal,
          ),
        );
      this.userId = account.user_id;
    }
    const result = z
      .object({ successful: z.boolean(), data: z.unknown() })
      .parse(
        await this.json(`/api/v3.1/tools/execute/${tool}`, signal, {
          user_id: this.userId,
          connected_account_id: this.config.account,
          version: VERSION,
          arguments: { user_id: "me", ...args },
        }),
      );
    if (!result.successful)
      throw new DomainError(
        502,
        "GMAIL_UNAVAILABLE",
        "Gmail could not return the requested input. Retry capture.",
      );
    return result.data;
  }
  async search(
    query: string,
    pageToken: string | undefined,
    signal: AbortSignal,
  ) {
    const result = z
      .object({
        messages: z.array(rawMessage),
        nextPageToken: z.string().nullish(),
      })
      .parse(
        await this.execute(
          "GMAIL_FETCH_EMAILS",
          {
            query,
            max_results: 25,
            verbose: false,
            include_payload: false,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
          signal,
        ),
      );
    return {
      messages: result.messages.map(summary),
      next_page_token: result.nextPageToken || null,
    };
  }
  async message(id: string, signal: AbortSignal): Promise<GmailMessage> {
    const m = rawMessage.parse(
      await this.execute(
        "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        { message_id: id, format: "full" },
        signal,
      ),
    );
    if (m.messageId !== id)
      throw new DomainError(
        502,
        "GMAIL_MESSAGE_CHANGED",
        "Gmail returned a different message than requested.",
      );
    return {
      ...summary(m),
      text: m.messageText,
      attachments: m.attachmentList.map((a) => ({
        id: a.attachmentId,
        name: a.filename,
        media_type: a.mimeType,
      })),
    };
  }
  async attachment(
    messageId: string,
    attachment: GmailMessage["attachments"][number],
    signal: AbortSignal,
  ) {
    const result = z.object({ file: z.object({ s3url: z.string() }) }).parse(
      await this.execute(
        "GMAIL_GET_ATTACHMENT",
        {
          message_id: messageId,
          attachment_id: attachment.id,
          file_name: attachment.name,
        },
        signal,
      ),
    );
    return boundedBytes(
      await this.request(attachmentUrl(result.file.s3url), {
        signal,
        redirect: "error",
      }),
      25 * 1024 * 1024,
    );
  }
}
export function gmailReader(): GmailReader {
  const key = process.env.COMPOSIO_API_KEY,
    account = process.env.COMPOSIO_GMAIL_CONNECTED_ACCOUNT_ID;
  if (!key || !account)
    throw new DomainError(
      503,
      "GMAIL_NOT_CONFIGURED",
      "Configure the read-only Gmail connection before searching.",
    );
  return new ComposioGmail({ key, account });
}
