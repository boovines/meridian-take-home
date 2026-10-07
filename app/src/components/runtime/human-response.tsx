"use client";
import { useState } from "react";
import type { HumanRequest, HumanResponse } from "@/domain/runtime";
export function HumanResponseForm({
  request,
  disabled,
  onAnswer,
}: {
  request: HumanRequest;
  disabled: boolean;
  onAnswer: (response: HumanResponse) => Promise<void>;
}) {
  const [text, setText] = useState("");
  return (
    <section className="human-response" aria-label="Human response required">
      <span className="eyebrow">Your response is needed</span>
      <h3>
        {request.response_type === "approval"
          ? "Review and decide"
          : "Answer to continue"}
      </h3>
      <p className="preserve-lines">{request.prompt}</p>
      <label>
        {request.response_type === "approval"
          ? "Decision note (optional)"
          : "Your answer"}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={20000}
          required={request.response_type === "text"}
          aria-describedby={`human-help-${request.id}`}
          disabled={disabled}
        />
      </label>
      <p id={`human-help-${request.id}`} className="field-help">
        This response applies to this visit only. New or replacement documents
        require a new run.
      </p>
      <div className="button-row">
        {request.response_type === "approval" ? (
          <>
            <button
              className="primary"
              disabled={disabled}
              onClick={() =>
                void onAnswer({ type: "approval", approved: true, text })
              }
            >
              Approve and resume
            </button>
            <button
              disabled={disabled}
              onClick={() =>
                void onAnswer({ type: "approval", approved: false, text })
              }
            >
              Reject and resume
            </button>
          </>
        ) : (
          <button
            className="primary"
            disabled={disabled || !text.trim()}
            onClick={() => void onAnswer({ type: "text", text })}
          >
            Submit answer and resume
          </button>
        )}
      </div>
    </section>
  );
}
