import { z } from "zod";
export const draftRequest = z
  .object({ recipient: z.union([z.literal(""), z.email().max(320)]) })
  .strict();
export const emailPreview = z.object({
  subject: z
    .string()
    .min(1)
    .max(998)
    .refine((v) => !/[\r\n]/.test(v)),
  body: z.string().min(1).max(100000),
});
export function previewFromOutput(output: unknown) {
  if (!output || typeof output !== "object" || Array.isArray(output))
    return null;
  const value = output as Record<string, unknown>;
  const parsed = emailPreview.safeParse(value.preview ?? value.report);
  return parsed.success ? parsed.data : null;
}
export interface GmailDraftWriter {
  account: string;
  create(
    input: { subject: string; body: string; recipient: string },
    signal: AbortSignal,
  ): Promise<string>;
}
export interface DraftRecord {
  state: "creating" | "created" | "uncertain";
  draft_id: string | null;
  recipient: string;
  subject: string;
  body: string;
}
export interface DraftState {
  enabled: boolean;
  eligible: boolean;
  reason: string | null;
  draft: DraftRecord | null;
}
