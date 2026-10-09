"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { api, errorMessage } from "@/lib/api";
import type {
  GroupedExecutionDetail,
  GroupingQuestion,
  GroupExecution,
} from "@/domain/grouped-execution";
import type { WorkflowJob } from "@/domain/engineering";
import { GmailPicker } from "../runtime/gmail-picker";
import { RunResult } from "../runtime/run-result";
import type { RunPanel } from "../runtime/run-panel";
import { GroupRunInspector } from "./group-run-inspector";
import { GroupWorkbench } from "./group-workbench";
import "../runtime/run-panel.css";
import "./grouped-execution.css";
const active = (job: WorkflowJob) =>
  ["queued", "running", "waiting_for_human", "cancel_requested"].includes(
    job.status,
  );
function label(execution: GroupExecution) {
  return execution.completed
    ? "Completed"
    : execution.active_job.status === "waiting_for_human"
      ? "Needs response"
      : execution.recovery && !execution.terminal
        ? "Recovering"
        : execution.terminal
          ? "Needs attention"
          : execution.active_job.status === "queued"
            ? "Queued"
            : "Running";
}
function Question({
  question,
  disabled,
  onAnswer,
}: {
  question: GroupingQuestion;
  disabled: boolean;
  onAnswer: (id: string, answer: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  return (
    <form
      className="group-question"
      onSubmit={(e) => {
        e.preventDefault();
        void onAnswer(question.id, answer);
      }}
    >
      <span className="eyebrow">Source clarification</span>
      <h4>{question.question}</h4>
      <p className="field-help">{question.scope}</p>
      <label>
        {" "}
        Your answer
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          maxLength={10000}
          disabled={disabled}
          required
        />
      </label>
      <button className="primary" disabled={disabled || !answer.trim()}>
        Save answer
      </button>
      <p className="field-help">
        The workflow will regroup this evidence. Completed history is preserved.
      </p>
    </form>
  );
}
export function GroupedRunPanel({
  state,
  operationActive,
  onOperationStarted,
  onInspectCode,
}: ComponentProps<typeof RunPanel>) {
  const base = `/api/workflows/${state.workflow.id}`;
  const [history, setHistory] = useState<WorkflowJob[]>([]),
    [loaded, setLoaded] = useState(false),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<GroupedExecutionDetail | null>(null),
    [version, setVersion] = useState(""),
    [outcome, setOutcome] = useState(""),
    [inspect, setInspect] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const answerIntents = useRef(
      new Map<string, { answer: string; key: string }>(),
    ),
    selectedRef = useRef(""),
    sequence = useRef(0),
    startIntent = useRef<{ key: string; input: string } | null>(null);
  const versionId =
    version || (state.versions.length === 1 ? state.versions[0].id : "");
  const outcomes = state.spec.board.nodes.filter((n) => n.type === "outcome");
  const refresh = useCallback(
    async (id?: string) => {
      if (id) selectedRef.current = id;
      const seq = ++sequence.current;
      const list = await api<WorkflowJob[]>(
        `${base}/grouped-executions?spec=${state.spec.id}`,
      );
      const choice = selectedRef.current || list[0]?.id;
      const value = choice
        ? await api<GroupedExecutionDetail>(
            `${base}/grouped-executions/${choice}`,
          )
        : null;
      if (seq !== sequence.current) return;
      setLoaded(true);
      setHistory(list);
      setDetail(value);
      if (choice) {
        selectedRef.current = choice;
        setSelected(choice);
      }
    },
    [base, state.spec.id],
  );
  useEffect(() => {
    const counter = sequence;
    void refresh().catch((e) => setError(errorMessage(e)));
    return () => {
      counter.current++;
    };
  }, [refresh]);
  const running = !!detail && active(detail.job),
    acceptsAnswers =
      !!detail &&
      ["queued", "running", "waiting_for_human"].includes(detail.job.status);
  useEffect(() => {
    if (!running && !operationActive) return;
    const timer = setInterval(
      () => void refresh().catch((e) => setError(errorMessage(e))),
      2000,
    );
    return () => clearInterval(timer);
  }, [running, operationActive, refresh]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function start(ids: string[]) {
    const input = JSON.stringify({
      implementation_version_id: versionId,
      message_ids: ids,
      ...(outcome ? { aggregation_node_id: outcome } : {}),
    });
    if (startIntent.current?.input !== input)
      startIntent.current = { input, key: crypto.randomUUID() };
    const job = await api<WorkflowJob>(`${base}/grouped-executions`, "POST", {
      ...JSON.parse(input),
      request_key: startIntent.current!.key,
    });
    startIntent.current = null;
    setInspect("");
    await refresh(job.id);
    await onOperationStarted();
    setMessage(
      "Selected emails queued. Capture and grouping will start automatically.",
    );
  }
  const blocked = busy || operationActive || running;
  const setup = (
    <section className="run-setup">
      <span className="eyebrow">Selected emails</span>
      <h3>Run related work together</h3>
      <p className="field-help">
        Select emails once. Follow each group independently, then inspect the
        combined report.
      </p>
      <label>
        Implementation to run
        <select
          value={versionId}
          disabled={blocked}
          onChange={(e) => setVersion(e.target.value)}
        >
          <option value="" disabled>
            Select code
          </option>
          {state.versions.map((v) => (
            <option key={v.id} value={v.id}>
              Code v{v.version_number} ·{" "}
              {new Date(v.created_at).toLocaleDateString()}
            </option>
          ))}
        </select>
      </label>
      {outcomes.length > 1 && (
        <label>
          Combined report step
          <select
            value={outcome}
            disabled={blocked}
            onChange={(e) => setOutcome(e.target.value)}
          >
            <option value="">Choose an approved Outcome</option>
            {outcomes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {!versionId && (
        <p className="field-help">
          Choose a code version before selecting emails.
        </p>
      )}
      {operationActive && (
        <p className="field-help">
          Finish or cancel the active operation before starting another.
        </p>
      )}
      <GmailPicker
        workflowId={state.workflow.id}
        disabled={blocked || !versionId || (outcomes.length > 1 && !outcome)}
        onSelected={start}
      />
    </section>
  );
  const historyView = (
    <section className="run-history">
      <h3>Recent email runs</h3>
      {history.length ? (
        history.map((j) => (
          <button
            key={j.id}
            aria-pressed={j.id === selected}
            onClick={() => {
              setInspect("");
              setDetail(null);
              setLoaded(false);
              setError("");
              void refresh(j.id).catch((e) => setError(errorMessage(e)));
            }}
          >
            <span>
              <strong>
                {Array.isArray(j.source_request.message_ids)
                  ? j.source_request.message_ids.length
                  : "Selected"}{" "}
                {Array.isArray(j.source_request.message_ids) &&
                j.source_request.message_ids.length === 1
                  ? "email"
                  : "emails"}
              </strong>
              <small>{new Date(j.created_at).toLocaleString()}</small>
            </span>
            <span>
              {j.status === "succeeded"
                ? "Completed"
                : j.status === "failed"
                  ? "Needs attention"
                  : j.status.replaceAll("_", " ")}
            </span>
          </button>
        ))
      ) : (
        <p className="field-help">Your selected-email runs will appear here.</p>
      )}
    </section>
  );
  const selectedChild = detail?.children.find((c) => c.id === inspect);
  const selectedExecution =
    inspect === "grouping"
      ? detail?.grouping
      : inspect === "aggregate"
        ? detail?.aggregate
        : selectedChild?.execution;
  const nodeTitles = Object.fromEntries(
    state.spec.board.nodes.map((n) => [n.id, n.title]),
  );
  const summary = detail ? (
    <section className="group-summary">
      <div className="group-section-heading">
        <div>
          <span className="eyebrow">
            {detail.job.status === "succeeded"
              ? "Execution complete"
              : detail.job.status === "failed"
                ? "Needs attention"
                : detail.job.phase.replaceAll("_", " ")}
          </span>
          <h3>
            {Array.isArray(detail.job.source_request.message_ids)
              ? detail.job.source_request.message_ids.length
              : "Selected"}{" "}
            {Array.isArray(detail.job.source_request.message_ids) &&
            detail.job.source_request.message_ids.length === 1
              ? "email"
              : "emails"}{" "}
            · {detail.children.length} groups
          </h3>
        </div>
        {running && (
          <button
            disabled={busy || detail.job.status === "cancel_requested"}
            onClick={() =>
              void act(async () => {
                await api(`${base}/jobs/${detail.job.id}/cancel`, "POST", {});
                await refresh();
                await onOperationStarted();
              })
            }
          >
            {detail.job.status === "cancel_requested"
              ? "Stopping…"
              : "Cancel email run"}
          </button>
        )}
      </div>
      <div className="group-metrics">
        <span>
          <strong>{detail.completed_groups}</strong> completed
        </span>
        <span>
          <strong>{detail.failed_groups}</strong> need attention
        </span>
        <span>
          <strong>{detail.coverage?.needs_clarification_count ?? 0}</strong>{" "}
          unresolved sources
        </span>
      </div>
      <p className="field-help">
        Execution status is separate from business correctness. Reports are
        previews; nothing is sent.
      </p>
      {detail.job.error_message && (
        <p role="alert" className="inline-error">
          {detail.job.error_message}
        </p>
      )}
      {detail.questions
        .filter((q) => q.status === "open")
        .map((q) => (
          <Question
            key={q.id}
            question={q}
            disabled={busy || !acceptsAnswers}
            onAnswer={(id, answer) =>
              act(async () => {
                const prior = answerIntents.current.get(id);
                const intent =
                  prior?.answer === answer
                    ? prior
                    : { answer, key: crypto.randomUUID() };
                answerIntents.current.set(id, intent);
                await api(`${base}/grouping-questions/${id}/answer`, "POST", {
                  request_key: intent.key,
                  answer,
                });
                await refresh();
                setMessage("Answer saved. The workflow will continue.");
              })
            }
          />
        ))}
      <details className="group-evidence">
        <summary>Source coverage and limits</summary>
        <p>
          {detail.coverage
            ? `${detail.coverage.source_count} sources · ${detail.coverage.assigned_count} assigned · ${detail.coverage.excluded_count} excluded · ${detail.coverage.needs_clarification_count} awaiting clarification`
            : "Sources have not been grouped yet."}
        </p>
        {detail.decision?.result.assignments.map((a) => (
          <div key={a.source_id}>
            <code>{a.source_id}</code>
            <p>
              {a.targets
                .map(
                  (t) =>
                    `${detail.decision?.result.groups.find((g) => g.key === t.group_key)?.label ?? t.group_key}: ${t.scope} (${t.reason})`,
                )
                .join("; ") || a.exclusion_reason}
            </p>
            {a.unresolved && (
              <p>
                Needs clarification: {a.unresolved.scope} —{" "}
                {a.unresolved.question}
              </p>
            )}
          </div>
        ))}
        <p>
          ${detail.spent_or_reserved_usd.toFixed(2)} spent or reserved of $
          {detail.record.limits.spend_usd} ·{" "}
          {Math.round(detail.record.active_elapsed_ms / 1000)} active seconds of{" "}
          {detail.record.limits.active_ms / 1000}
        </p>
        {detail.questions
          .filter((q) => q.status !== "open")
          .map((q) => (
            <p key={q.id}>
              <strong>{q.question}</strong> — {q.answer ?? q.status}
            </p>
          ))}
      </details>
    </section>
  ) : (
    <section className="group-summary group-empty">
      <span className="eyebrow">One selection, independent results</span>
      <h3>Follow every group from input to report</h3>
      <p>
        Related emails are grouped by the approved workflow. Ambiguous sources
        ask for clarification, while independent groups keep moving.
      </p>
    </section>
  );
  const groups = (
    <section className="group-list">
      <div className="group-section-heading">
        <h3>Groups</h3>
        {detail?.grouping && (
          <button
            aria-pressed={inspect === "grouping"}
            onClick={() => setInspect("grouping")}
          >
            Inspect grouping
          </button>
        )}
      </div>
      {detail?.children.length ? (
        <div className="group-rows">
          {detail.children.map((c) => (
            <button
              className="group-row"
              key={c.id}
              aria-pressed={inspect === c.id}
              onClick={() => setInspect(c.id)}
            >
              <span>
                <strong>{c.label}</strong>
                <small>
                  Code v{c.execution.version_number}
                  {c.execution.recovery ? " · Recovery history" : ""}
                </small>
              </span>
              <span
                className={`group-status ${c.execution.completed ? "complete" : c.execution.terminal ? "attention" : ""}`}
              >
                {label(c.execution)}
              </span>
              <span className="group-inspect-label">Inspect →</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="field-help">
          {running
            ? "Groups appear once the selected sources have been read."
            : "No groups yet."}
        </p>
      )}
      {detail?.aggregate && (
        <button
          className="group-report-button"
          aria-pressed={inspect === "aggregate"}
          onClick={() => setInspect("aggregate")}
        >
          Inspect combined report · {label(detail.aggregate)}
        </button>
      )}
      {detail?.aggregate?.completed && detail.aggregate.output !== null && (
        <div className="group-report">
          <span className="eyebrow">
            Combined report · unverified business results
          </span>
          <RunResult output={detail.aggregate.output} />
        </div>
      )}
      {!!detail && detail.child_history.length > detail.children.length && (
        <details className="group-evidence">
          <summary>Earlier grouping decisions and runs</summary>
          {detail.child_history
            .filter((h) => !detail.children.some((c) => c.id === h.id))
            .map((h) => {
              const e = detail.executions.find(
                (e) => e.source_job_id === h.job_id,
              );
              return e ? (
                <button key={h.id} onClick={() => setInspect(h.id)}>
                  {h.label} · previous input · Code v{e.version_number}
                </button>
              ) : null;
            })}
        </details>
      )}
    </section>
  );
  const historic = detail?.child_history.find((h) => h.id === inspect),
    execution =
      selectedExecution ??
      detail?.executions.find((e) => e.source_job_id === historic?.job_id);
  const inspection = execution ? (
    <GroupRunInspector
      key={`${selected}-${inspect}`}
      workflowId={state.workflow.id}
      execution={execution}
      title={
        selectedChild?.label ??
        historic?.label ??
        (inspect === "grouping" ? "Grouping sources" : "Combined report")
      }
      nodeTitles={nodeTitles}
      parentActive={acceptsAnswers}
      onUpdated={async () => {
        await refresh();
        await onOperationStarted();
      }}
      onInspectCode={onInspectCode}
    />
  ) : (
    <section className="group-inspector group-empty">
      <h3>Inspect a group</h3>
      <p>
        Select a group to see its results, step history, repair attempts and any
        questions that need a response.
      </p>
    </section>
  );
  if (!loaded && !error)
    return <p role="status">Loading selected-email runs…</p>;
  return (
    <div>
      {error && (
        <p role="alert" className="inline-error">
          {error}{" "}
          <button onClick={() => void act(() => refresh())}>
            Refresh progress
          </button>
        </p>
      )}
      {message && (
        <p role="status" className="run-notice">
          {message}
        </p>
      )}
      <GroupWorkbench
        hasHistory={history.length > 0}
        setup={setup}
        history={historyView}
        summary={summary}
        groups={groups}
        inspection={inspection}
      />
    </div>
  );
}
