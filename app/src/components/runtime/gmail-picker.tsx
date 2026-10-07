"use client";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { GmailSummary } from "@/domain/gmail";
export function GmailPicker({
  workflowId,
  disabled,
  onCaptured,
}: {
  workflowId: string;
  disabled: boolean;
  onCaptured: (id: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("has:attachment"),
    [searchedQuery, setSearchedQuery] = useState(""),
    [shipment, setShipment] = useState(""),
    [messages, setMessages] = useState<GmailSummary[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [next, setNext] = useState<string | null>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  async function search(more = false) {
    setBusy("Searching Gmail…");
    setError("");
    try {
      const data = await api<{
        messages: GmailSummary[];
        next_page_token: string | null;
      }>(
        `/api/workflows/${workflowId}/gmail/messages?${new URLSearchParams({ query: more ? searchedQuery : query, ...(more && next ? { page_token: next } : {}) })}`,
      );
      setMessages(
        more
          ? [
              ...messages,
              ...data.messages.filter(
                (m) => !messages.some((old) => old.id === m.id),
              ),
            ]
          : data.messages,
      );
      setNext(data.next_page_token);
      if (!more) {
        setSelected([]);
        setSearchedQuery(query);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function capture() {
    setBusy(
      "Capturing emails and attachments. Large packets can take a few minutes…",
    );
    setError("");
    try {
      const data = await api<{ id: string }>(
        `/api/workflows/${workflowId}/gmail/capture`,
        "POST",
        { message_ids: selected, shipment_reference: shipment.trim() },
      );
      await onCaptured(data.id);
      setSelected([]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <details className="gmail-picker">
      <summary>Capture from Gmail</summary>
      <p className="field-help">
        Select all related emails, including certificates sent separately. Gmail
        is read-only.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label>
          Shipment number or Gmail search
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={500}
            disabled={!!busy || disabled}
          />
        </label>
        <button disabled={!!busy || disabled}>Search emails</button>
      </form>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {!!searchedQuery && !messages.length && !busy && (
        <p>No messages matched. Try the invoice number or a broader search.</p>
      )}
      {!!messages.length && (
        <>
          <div className="gmail-message-list" aria-label="Matching emails">
            {messages.map((m) => (
              <label key={m.id} className="gmail-message">
                <input
                  type="checkbox"
                  checked={selected.includes(m.id)}
                  disabled={
                    !!busy ||
                    disabled ||
                    (selected.length >= 10 && !selected.includes(m.id))
                  }
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...selected, m.id]
                        : selected.filter((id) => id !== m.id),
                    )
                  }
                />
                <span>
                  <strong>{m.subject}</strong>
                  <small>
                    {m.sender} ·{" "}
                    {m.received_at
                      ? new Date(m.received_at).toLocaleDateString()
                      : "Date unavailable"}
                  </small>
                </span>
              </label>
            ))}
          </div>
          {next && (
            <button
              disabled={!!busy || disabled}
              onClick={() => void search(true)}
            >
              Load more emails
            </button>
          )}
          <label>
            Shipment reference
            <input
              value={shipment}
              onChange={(e) => setShipment(e.target.value)}
              placeholder="Container number or MAWB"
              required
              maxLength={200}
              disabled={!!busy || disabled}
            />
          </label>
          <button
            disabled={
              !!busy || disabled || !selected.length || !shipment.trim()
            }
            onClick={() => void capture()}
          >
            Capture {selected.length || "selected"} email
            {selected.length === 1 ? "" : "s"}
          </button>
          <p className="field-help">
            Creates a fixed copy of the selected emails and every attachment. Up
            to 10 emails per packet.
          </p>
        </>
      )}
      {busy && (
        <p role="status" className="field-help">
          {busy}
        </p>
      )}
    </details>
  );
}
