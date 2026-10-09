"use client";
import { useState } from "react";
import type { EngineerQuestion } from "@/domain/clarification";
import { api, errorMessage } from "@/lib/api";
export function EngineerQuestionCard({
  question,
  onAnswered,
  onInspectEvidence,
}: {
  question: EngineerQuestion;
  onAnswered: () => Promise<void>;
  onInspectEvidence: () => void;
}) {
  const [answer, setAnswer] = useState(""),
    [reuse, setReuse] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // Keep the key across a lost response; identical resubmission is idempotent.
  const [submission, setSubmission] = useState<{
    key: string;
    answer: string;
    reuse: boolean;
  } | null>(null);
  async function submit() {
    const next =
      submission?.answer === answer && submission.reuse === reuse
        ? submission
        : { key: crypto.randomUUID(), answer, reuse };
    setSubmission(next);
    setBusy(true);
    setError("");
    try {
      await api(
        `/api/workflows/${question.workflow_id}/engineer-questions/${question.id}/answer`,
        "POST",
        { request_key: next.key, answer, reuse },
      );
      await onAnswered();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="recovery-question" aria-label="Engineer clarification">
      <strong>{question.question}</strong>
      <p>{question.why_needed}</p>
      <button onClick={onInspectEvidence}>Inspect original run evidence</button>
      {question.status === "open" ? (
        <>
          <label htmlFor={`answer-${question.id}`}>Your clarification</label>
          <textarea
            id={`answer-${question.id}`}
            value={answer}
            maxLength={4000}
            onChange={(e) => setAnswer(e.target.value)}
            disabled={busy}
            placeholder="Clarify the existing rule or explain where to find the supporting evidence."
          />
          <label className="recovery-reuse">
            <input
              type="checkbox"
              checked={reuse}
              disabled={busy}
              onChange={(e) => setReuse(e.target.checked)}
            />
            Use for future runs of this workflow
          </label>
          <p className="field-help">
            Applies to this captured input by default. The agent must inspect
            supporting evidence again. Changing the process or adding documents
            requires separate work.
          </p>
          {error && <p role="alert">{error}</p>}
          <button
            className="primary"
            onClick={() => void submit()}
            disabled={busy || !answer.trim()}
          >
            {busy ? "Submitting…" : "Submit and continue"}
          </button>
        </>
      ) : (
        <>
          <p>
            {question.status === "cancelled"
              ? "Question canceled. Recovery has stopped."
              : question.answer}
          </p>
          {question.status === "answered" && (
            <p className="field-help">
              {question.reuse
                ? "Saved for future runs of this frozen workflow."
                : "Applies only to this captured input."}
            </p>
          )}
        </>
      )}
    </section>
  );
}
