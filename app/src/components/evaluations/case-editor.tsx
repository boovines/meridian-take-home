"use client";
import { useState } from "react";
import { z } from "zod";
import type { CanvasNode } from "@/domain/canvas";
import { caseInput, type EvaluationCase } from "@/domain/evaluation";
import { errorMessage } from "@/lib/api";
import type { BundleSummary } from "./types";
export function CaseEditor({
  initial,
  nodes,
  bundles,
  onSave,
  onCancel,
}: {
  initial?: EvaluationCase;
  nodes: CanvasNode[];
  bundles: BundleSummary[];
  onSave: (data: z.infer<typeof caseInput>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || ""),
    [kind, setKind] = useState(initial?.kind || "workflow"),
    [node, setNode] = useState(initial?.node_id || nodes[0]?.id || ""),
    [bundle, setBundle] = useState(
      initial?.input_bundle_id || bundles[0]?.id || "",
    ),
    [context, setContext] = useState(
      JSON.stringify(initial?.input_data || { input: {}, steps: {} }, null, 2),
    ),
    [responses, setResponses] = useState(
      JSON.stringify(initial?.human_responses || [], null, 2),
    ),
    [checks, setChecks] = useState(
      initial?.assertions.map((a) => ({
        ...a,
        operator: a.operator || "equals",
        path: JSON.stringify(a.path),
        expected: JSON.stringify(a.expected, null, 2),
      })) || [
        {
          key: "result",
          label: "Expected result",
          path: "[]",
          expected: "{}",
          operator: "equals" as const,
        },
      ],
    ),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const [key] = useState(initial?.case_key || crypto.randomUUID());
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const data = caseInput.parse({
        case_key: key,
        name,
        kind,
        node_id: kind === "step" ? node : null,
        input_bundle_id: kind === "workflow" ? bundle : null,
        input_data: kind === "step" ? JSON.parse(context) : null,
        human_responses: kind === "workflow" ? JSON.parse(responses) : [],
        assertions: checks.map((c) => ({
          ...c,
          path: JSON.parse(c.path),
          expected: JSON.parse(c.expected),
        })),
      });
      await onSave(data);
    } catch (e) {
      setError(
        e instanceof z.ZodError
          ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
          : e instanceof SyntaxError
            ? "Check the JSON in inputs, output paths, and expected values. Your edits are still here."
            : errorMessage(e),
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      className="case-editor"
      onSubmit={submit}
      aria-label={initial ? "Edit test case" : "New test case"}
    >
      <h3>{initial ? "Edit test case" : "Add a test case"}</h3>
      <p className="field-help">
        Define the input and independently checked answer. Saving an edit clears
        its verification.
      </p>
      <label>
        Case name
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
        />
      </label>
      <label>
        Test scope
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as "workflow" | "step")}
        >
          <option value="workflow">Full workflow</option>
          <option value="step">One step</option>
        </select>
      </label>
      {kind === "workflow" ? (
        <>
          <label>
            Captured input
            <select
              required
              value={bundle}
              onChange={(e) => setBundle(e.target.value)}
            >
              <option value="">Choose an input</option>
              {bundles.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.shipment_reference || "Captured input"} · {b.source_kind} ·{" "}
                  {new Date(b.created_at).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          {!bundles.length && (
            <p className="field-help">
              Capture an input in the Agent tab before adding a workflow case.
              Step cases can use JSON inputs.
            </p>
          )}
          <details>
            <summary>Human responses for this case</summary>
            <p className="field-help">
              Each response belongs to one block and visit. Missing responses
              produce an execution error.
            </p>
            <label>
              Scripted responses (JSON)
              <textarea
                rows={6}
                spellCheck={false}
                value={responses}
                onChange={(e) => setResponses(e.target.value)}
              />
            </label>
            <p className="field-help">
              Example:{" "}
              {`[{"node_id":"<block ID>","node_visit_number":1,"response":{"type":"approval","approved":true,"text":"Checked"}}]`}
            </p>
            <div className="fixture-node-list">
              {nodes.map((n) => (
                <p key={n.id}>
                  {n.title}: <code>{n.id}</code>
                </p>
              ))}
            </div>
          </details>
        </>
      ) : (
        <>
          <label>
            Step
            <select
              required
              value={node}
              onChange={(e) => setNode(e.target.value)}
            >
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Step context (JSON)
            <textarea
              required
              rows={7}
              spellCheck={false}
              value={context}
              onChange={(e) => setContext(e.target.value)}
            />
          </label>
          <p className="field-help">
            Use input and steps (prior outputs keyed by block ID). A Human
            method also requires human_response.
          </p>
        </>
      )}
      <div className="case-checks-heading">
        <h4>Expected answers</h4>
        <button
          type="button"
          disabled={checks.length >= 100}
          onClick={() =>
            setChecks([
              ...checks,
              {
                key: crypto.randomUUID(),
                label: "",
                path: "[]",
                expected: "null",
                operator: "equals",
              },
            ])
          }
        >
          Add check
        </button>
      </div>
      <p className="field-help" id="check-path-help">
        A path selects output fields, such as {'["totals", "goods_failed"]'}.
        Use [] for the whole output. Record checks select an array and match
        fields in one record, regardless of its position.
      </p>
      {checks.map((c, i) => (
        <fieldset className="assertion-editor" key={c.key}>
          <legend>Check {i + 1}</legend>
          <label>
            Check label
            <input
              required
              value={c.label}
              onChange={(e) =>
                setChecks(
                  checks.map((x, n) =>
                    n === i ? { ...x, label: e.target.value } : x,
                  ),
                )
              }
            />
          </label>
          <label>
            Output path (JSON array)
            <input
              required
              aria-describedby="check-path-help"
              value={c.path}
              onChange={(e) =>
                setChecks(
                  checks.map((x, n) =>
                    n === i ? { ...x, path: e.target.value } : x,
                  ),
                )
              }
            />
          </label>
          <label>
            Comparison
            <select
              value={c.operator}
              aria-describedby={`check-comparison-help-${c.key}`}
              onChange={(e) =>
                setChecks(
                  checks.map((x, n) =>
                    n === i
                      ? {
                          ...x,
                          operator: e.target.value as NonNullable<
                            EvaluationCase["assertions"][number]["operator"]
                          >,
                        }
                      : x,
                  ),
                )
              }
            >
              <option value="equals">Equals exactly</option>
              <option value="contains_record">Contains a record</option>
              <option value="excludes_record">Excludes a record</option>
              <option value="text_includes">Text includes (ignores case and whitespace)</option>
              <option value="array_includes">Array includes exact value</option>
            </select>
          </label>
          <p className="field-help" id={`check-comparison-help-${c.key}`}>
            {c.operator === "equals"
              ? "Compare the complete JSON value. Array order matters."
              : "Enter a nonempty JSON object. All its fields must match one record exactly; extra fields are allowed. Missing or non-array output fails either record check."}
          </p>
          <label>
            Expected value (JSON)
            <textarea
              required
              aria-describedby={`check-comparison-help-${c.key}`}
              rows={3}
              spellCheck={false}
              value={c.expected}
              onChange={(e) =>
                setChecks(
                  checks.map((x, n) =>
                    n === i ? { ...x, expected: e.target.value } : x,
                  ),
                )
              }
            />
          </label>
          <button
            type="button"
            className="subtle"
            disabled={checks.length === 1}
            onClick={() => setChecks(checks.filter((_, n) => n !== i))}
          >
            Remove check {i + 1}
          </button>
        </fieldset>
      ))}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <div className="button-row">
        <button className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save case"}
        </button>
        <button type="button" disabled={saving} onClick={onCancel}>
          Cancel edit
        </button>
      </div>
    </form>
  );
}
