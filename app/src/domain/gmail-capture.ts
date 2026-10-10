import { z } from "zod";
export const captureProgress = z.object({
  messages_total: z.number(),
  messages_completed: z.number(),
  attachments_total: z.number(),
  attachments_completed: z.number(),
  attachments_unavailable: z.number(),
  warnings: z.array(
    z.object({ message_id: z.string(), name: z.string(), reason: z.string() }),
  ),
});
export type CaptureProgress = z.infer<typeof captureProgress>;
export const CAPTURE_LIMITS = {
  concurrency: 4,
  request_ms: 20_000,
  attempt_ms: 20 * 60_000,
  sources: 100,
  attachments: 90,
  bytes: 50 * 1024 * 1024,
} as const;
