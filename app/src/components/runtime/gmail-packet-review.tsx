"use client";
import type { GmailGrouping } from "@/domain/gmail-grouping";
import type { GmailSummary } from "@/domain/gmail";

export function GmailPacketReview({ value, messages, captured, disabled, onCapture }: {
  value: GmailGrouping;
  messages: GmailSummary[];
  captured: Record<string, string>;
  disabled: boolean;
  onCapture: () => void;
}) {
  const name = (id: string) => messages.find(m => m.id === id)?.subject || id;
  const remaining = value.groups.filter(g => !captured[g.reference]);
  return <section aria-label="Suggested shipment packets">
    <h4>{value.groups.length} suggested packet{value.groups.length === 1 ? "" : "s"}</h4>
    <p className="field-help">Check the references and email assignments below. Each packet is captured separately and runs with your existing code. Nothing runs automatically.</p>
    {value.groups.map(group => <details key={group.reference}>
      <summary>{group.reference} · {group.message_ids.length} email{group.message_ids.length === 1 ? "" : "s"}{captured[group.reference] ? " · Captured" : ""}</summary>
      <p>{group.reason}</p>
      <blockquote>{group.evidence.quote}</blockquote>
      <ul>{group.message_ids.map(id => <li key={id}>{name(id)}</li>)}</ul>
    </details>)}
    {!!value.unresolved.length && <div role="alert" className="inline-error">
      <p>{value.unresolved.length} email{value.unresolved.length === 1 ? " needs" : "s need"} clarification and will not be captured automatically:</p>
      <ul>{value.unresolved.map(item => <li key={item.message_id}><strong>{name(item.message_id)}</strong>: {item.reason}</li>)}</ul>
      <p>Select those emails separately and enter a confirmed reference using manual capture, or adjust your selection and prepare again.</p>
    </div>}
    {!!remaining.length && <button disabled={disabled} onClick={onCapture}>Capture {remaining.length} suggested packet{remaining.length === 1 ? "" : "s"}</button>}
    {!!value.groups.length && !remaining.length && <p role="status">Packets saved. Choose one under Captured input, then start its run.</p>}
  </section>;
}
