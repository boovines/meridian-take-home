import { z } from "zod";
export const gmailSearch = z
  .object({
    query: z.string().trim().max(500).default("has:attachment"),
    page_token: z.string().max(2000).optional(),
  })
  .strict();
export const gmailCapture = z
  .object({
    message_ids: z
      .array(z.string().regex(/^[a-f0-9]{10,40}$/))
      .min(1)
      .max(10)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Select each message once.",
      ),
    shipment_reference: z.string().trim().min(1).max(200),
  })
  .strict();
export interface GmailSummary {
  id: string;
  thread_id: string;
  subject: string;
  sender: string;
  received_at: string;
}
export interface GmailMessage extends GmailSummary {
  text: string;
  attachments: { id: string; name: string; media_type: string }[];
}
export interface GmailReader {
  search(
    query: string,
    pageToken: string | undefined,
    signal: AbortSignal,
  ): Promise<{ messages: GmailSummary[]; next_page_token: string | null }>;
  message(id: string, signal: AbortSignal): Promise<GmailMessage>;
  attachment(
    messageId: string,
    attachment: GmailMessage["attachments"][number],
    signal: AbortSignal,
  ): Promise<Buffer>;
}
