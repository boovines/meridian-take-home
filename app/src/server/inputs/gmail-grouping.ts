import type { GmailMessage, GmailReader } from "../../domain/gmail";
import { gmailGroupingRequest, validateGmailGrouping } from "../../domain/gmail-grouping";
import { DomainError } from "../../domain/errors";
import type { Database } from "../database";
import { readBoard } from "../workflows/store";
import { suggestEmailPackets } from "../integrations/openai-gmail-grouping";

export class GmailGroupingService {
  constructor(private db: Database, private reader: GmailReader, private suggest = suggestEmailPackets) {}
  async prepare(wid: string, raw: unknown, signal: AbortSignal) {
    const data = gmailGroupingRequest.parse(raw);
    const board = await readBoard(this.db, wid);
    const messages: GmailMessage[] = [];
    let bytes = 0;
    for (const id of data.message_ids) {
      signal.throwIfAborted();
      const message = await this.reader.message(id, signal);
      bytes += Buffer.byteLength(JSON.stringify(message));
      if (bytes > 512_000 || Buffer.byteLength(message.text) > 150_000)
        throw new DomainError(413, "EMAIL_CONTEXT_TOO_LARGE", "These email bodies are too large to identify packets together. Select a smaller set; no packets were captured.");
      if (message.id !== id) throw new DomainError(502, "EMAIL_ID_MISMATCH", "Gmail returned an unexpected message. No packets were captured.");
      messages.push(message);
    }
    const process = {
      name: board.workflow.name,
      desired_outcome: board.workflow.desired_outcome,
      steps: board.nodes.map(n => ({ type: n.type, title: n.title, instructions: n.instructions })),
    };
    try {
      return validateGmailGrouping(await this.suggest(process, messages, signal), messages);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(502, "EMAIL_GROUPING_FAILED", "Could not identify shipment packets from these emails. No packets were captured. Try again, or use manual capture for a confirmed shipment.");
    }
  }
}
