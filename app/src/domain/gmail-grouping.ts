import { z } from "zod";
import { gmailCapture, type GmailMessage } from "./gmail";
import { DomainError } from "./errors";

export const gmailGroupingRequest = z.object({
  message_ids: gmailCapture.shape.message_ids,
}).strict();
export const gmailGrouping = z.object({
  groups: z.array(z.object({
    reference: z.string().trim().min(1).max(200),
    message_ids: gmailCapture.shape.message_ids,
    evidence: z.object({ message_id: z.string(), quote: z.string().min(1).max(2000) }).strict(),
    reason: z.string().min(1).max(2000),
  }).strict()),
  unresolved: z.array(z.object({ message_id: z.string(), reason: z.string().min(1).max(2000) }).strict()),
}).strict();
export type GmailGrouping = z.infer<typeof gmailGrouping>;

// Verify coverage and literal source support. Semantic grouping is still a
// suggestion for the operator to inspect, not a business-accuracy verdict.
export function validateGmailGrouping(raw: unknown, messages: GmailMessage[]): GmailGrouping {
  const result = gmailGrouping.parse(raw);
  const byId = new Map(messages.map(m => [m.id, m]));
  const assigned = new Set<string>(), references = new Set<string>();
  const normalized = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const invalid = () => { throw new DomainError(422, "INVALID_EMAIL_GROUPING", "The suggested packets could not be verified against the selected emails. No packets were captured. Try again or select related emails manually."); };
  function account(id: string) {
    if (!byId.has(id) || assigned.has(id)) invalid();
    assigned.add(id);
  }
  for (const group of result.groups) {
    const key = normalized(group.reference);
    const source = byId.get(group.evidence.message_id);
    if (!key || references.has(key) || !group.message_ids.includes(group.evidence.message_id) ||
        !source?.text.includes(group.evidence.quote) || !normalized(group.evidence.quote).includes(key)) invalid();
    references.add(key);
    group.message_ids.forEach(account);
  }
  result.unresolved.forEach(item => account(item.message_id));
  if (assigned.size !== byId.size) invalid();
  return result;
}
