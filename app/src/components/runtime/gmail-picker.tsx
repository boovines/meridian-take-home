"use client";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { GmailGrouping } from "@/domain/gmail-grouping";
import { GmailPacketReview } from "./gmail-packet-review";
import type { GmailSummary } from "@/domain/gmail";
export function GmailPicker({
  workflowId,
  disabled,
  onCaptured,
  onSelected,
}: {
  workflowId: string;
  disabled: boolean;
  onCaptured?: (id: string) => Promise<void>;
  onSelected?: (ids: string[]) => Promise<void>;
}) {
  const [query, setQuery] = useState("has:attachment"),
    [searchedQuery, setSearchedQuery] = useState(""),
    [shipment, setShipment] = useState(""),
    [messages, setMessages] = useState<GmailSummary[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [next, setNext] = useState<string | null>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [prepared, setPrepared] = useState<GmailGrouping | null>(null),
    [captured, setCaptured] = useState<Record<string, string>>({});
  function select(ids: string[]) {
    setSelected(ids);
    setPrepared(null);
    setCaptured({});
  }
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
        select([]);
        setSearchedQuery(query);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function selectAll() {
    setBusy("Selecting all matching emails…");
    setError("");
    let loaded = messages;
    let cursor = next;
    const visited = new Set<string>();
    select(loaded.map((m) => m.id));
    try {
      while (cursor) {
        if (visited.has(cursor))
          throw new Error(
            "Gmail repeated a results page. Loaded emails remain selected; retry your search to load the rest.",
          );
        visited.add(cursor);
        const data = await api<{
          messages: GmailSummary[];
          next_page_token: string | null;
        }>(
          `/api/workflows/${workflowId}/gmail/messages?${new URLSearchParams({ query: searchedQuery, page_token: cursor })}`,
        );
        const byId = new Map(loaded.map((m) => [m.id, m]));
        for (const message of data.messages) byId.set(message.id, message);
        loaded = [...byId.values()];
        cursor = data.next_page_token;
        setMessages(loaded);
        select(loaded.map((m) => m.id));
        setNext(cursor);
        setBusy(`Selecting all matching emails… ${loaded.length} loaded`);
      }
    } catch (e) {
      setError(
        `Could not select every matching email. ${loaded.length} loaded emails remain selected. ${errorMessage(e)}`,
      );
    } finally {
      setBusy("");
    }
  }
  async function prepare() {
    setBusy("Reading selected email bodies to identify shipment packets…");
    setError("");
    setPrepared(null);
    setCaptured({});
    try {
      setPrepared(await api<GmailGrouping>(`/api/workflows/${workflowId}/gmail/prepare`, "POST", { message_ids: selected }));
    } catch (e) {
      setError(errorMessage(e));
    } finally { setBusy(""); }
  }
  async function capturePackets() {
    if (!prepared) return;
    setError("");
    try {
      for (const group of prepared.groups) {
        if (captured[group.reference]) continue;
        setBusy(`Capturing ${group.reference} and its attachments…`);
        const packet = await api<{id: string}>(`/api/workflows/${workflowId}/gmail/capture`, "POST", {
          message_ids: group.message_ids, shipment_reference: group.reference,
        });
        // Remember successful packets even when a later capture or UI refresh fails.
        setCaptured(current => ({ ...current, [group.reference]: packet.id }));
        await onCaptured?.(packet.id);
      }
    } catch (e) {
      setError(`Capture stopped. Packets already marked Captured remain saved; retry captures only the rest. ${errorMessage(e)}`);
    } finally { setBusy(""); }
  }
  async function capture() {
    setBusy(
      onSelected
        ? "Starting selected-email run…"
        : "Capturing emails and attachments. Large packets can take a few minutes…",
    );
    setError("");
    try {
      if (onSelected) {
        await onSelected(selected);
        setSelected([]);
        return;
      }
      const data = await api<{ id: string }>(
        `/api/workflows/${workflowId}/gmail/capture`,
        "POST",
        { message_ids: selected, shipment_reference: shipment.trim() },
      );
      await onCaptured?.(data.id);
      select([]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <details className="gmail-picker" open={onSelected ? true : undefined}>
      <summary>{onSelected ? "Select emails" : "Capture from Gmail"}</summary>
      <p className="field-help">
        {onSelected
          ? "Select all relevant emails. The workflow groups related work automatically and asks about ambiguous sources."
          : "Select emails across shipments, including certificates sent separately. We’ll suggest separate packets and read their references from email bodies. Gmail is read-only."}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label>
          Search Gmail
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
        <p>
          No messages matched. Try a different reference or a broader search.
        </p>
      )}
      {!!messages.length && (
        <>
          <div className="button-row">
            <button disabled={!!busy || disabled} onClick={() => void selectAll()}>
              Select all results
            </button>
            <button disabled={!!busy || disabled || !selected.length} onClick={() => select([])}>
              Clear selection
            </button>
          </div>
          <p className="field-help" aria-live="polite">{selected.length} selected</p>
          <div className="gmail-message-list" aria-label="Matching emails">
            {messages.map((m) => (
              <label key={m.id} className="gmail-message">
                <input
                  type="checkbox"
                  checked={selected.includes(m.id)}
                  disabled={!!busy || disabled}
                  onChange={(e) =>
                    select(
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
          {!onSelected && <>
          <button disabled={!!busy || disabled || !selected.length} onClick={() => void prepare()}>
            Prepare shipment packets
          </button>
          {prepared && <GmailPacketReview value={prepared} messages={messages} captured={captured} disabled={!!busy || disabled} onCapture={() => void capturePackets()} />}
          <details>
            <summary>Enter a reference manually</summary>
            <p className="field-help">Only use this when the selected emails all belong to one confirmed shipment.</p>
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
          </details>
          </>}
          <button
            disabled={
              !!busy ||
              disabled ||
              !selected.length ||
              (!onSelected && !shipment.trim())
            }
            onClick={() => void capture()}
          >
            {onSelected
              ? "Run selected emails"
              : `Capture ${selected.length || "selected"} email${selected.length === 1 ? "" : "s"}`}
          </button>
          <p className="field-help">
            {onSelected ? "Captures the selected emails and attachments, then starts processing. Reports are previewed only." : "Creates a fixed copy of the selected emails and every attachment. Select related emails for one shipment per packet."}
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
