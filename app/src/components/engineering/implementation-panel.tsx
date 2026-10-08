"use client";
import { api } from "@/lib/api";
import type { PlanStep, Method } from "@/domain/engineering";
import type { EngineeringState } from "./types";
import PlanChoices from "./plan-choices";
export function ImplementationPanel({
  state,
  selectedPlan,
  setSelectedPlan,
  busy,
  operationActive,
  mutate,
  onGenerated,
}: {
  state: EngineeringState;
  selectedPlan: string;
  setSelectedPlan: (id: string) => void;
  busy: boolean;
  operationActive: boolean;
  mutate: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  onGenerated: () => void;
}) {
  const id = state.workflow.id,
    base = `/api/workflows/${id}`;
  const plan = state.plans.find((p) => p.id === selectedPlan) || state.plans[0],
    steps = state.steps.filter((s) => s.plan_version_id === plan?.id) || [],
    approved = steps.filter((s) => s.approved_at).length;
  function change(
    step: PlanStep,
    values: { selected_method?: Method; approved?: boolean },
  ) {
    void mutate("Saving choice…", () =>
      api(
        `/api/workflows/${id}/plans/${step.plan_version_id}/steps/${step.node_id}`,
        "PATCH",
        { expected_revision: step.revision, ...values },
      ),
    );
  }
  return (
    <>
      <div className="engineer-section-heading">
        <div>
          <span className="eyebrow">Implementation plan</span>
          <h2>Decide how each step works.</h2>
          <p className="field-help">
            Suggest methods fills in the choices below. Review and approve them
            before generation; changed choices need approval again.
          </p>
        </div>
        {plan && (
          <label>
            Plan version
            <select
              aria-label="Plan version"
              value={plan.id}
              onChange={(e) => setSelectedPlan(e.target.value)}
            >
              {state.plans.map((p) => (
                <option key={p.id} value={p.id}>
                  v{p.version_number} · {p.state}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {!plan ? (
        <div className="engineer-empty">
          <h3>The customer’s process is ready for implementation.</h3>
          <p>
            Create a plan to select Code, Agent, or Human for each frozen step.
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void mutate("Creating plan…", () =>
                api(`${base}/plans`, "POST", {
                  request_key: crypto.randomUUID(),
                }),
              )
            }
          >
            Create implementation plan
          </button>
        </div>
      ) : (
        <>
          <div className="plan-actions">
            <span>
              {approved} of {steps.length} steps approved · Plan {plan.state}
            </span>
            <div className="button-row">
              {plan.state === "draft" ? (
                <button
                  disabled={busy || operationActive}
                  onClick={() =>
                    void mutate("Preparing AI recommendations…", () =>
                      api(`${base}/plans/${plan.id}/recommend`, "POST", {
                        expected_revision: plan.revision,
                      }),
                    )
                  }
                >
                  Suggest methods
                </button>
              ) : (
                <button
                  disabled={
                    busy || state.plans.some((p) => p.state === "draft")
                  }
                  onClick={() =>
                    void mutate("Creating plan revision…", async () => {
                      const next = await api<{ id: string }>(
                        `${base}/plans`,
                        "POST",
                        {
                          request_key: crypto.randomUUID(),
                          parent_plan_version_id: plan.id,
                        },
                      );
                      setSelectedPlan(next.id);
                    })
                  }
                >
                  Revise plan
                </button>
              )}
            </div>
          </div>
          <PlanChoices
            nodes={state.spec.board.nodes}
            steps={steps}
            disabled={busy || plan.state === "approved"}
            onChange={change}
          />
          <div className="plan-footer">
            <p className="field-help">
              {plan.state === "approved"
                ? "This plan is sealed. Changes require a new plan version."
                : "Changing a method clears that step’s approval. Human steps required by the customer stay human."}
            </p>
            <div className="button-row">
              <button
                disabled={
                  busy || plan.state === "approved" || approved !== steps.length
                }
                onClick={() =>
                  void mutate("Approving plan…", () =>
                    api(`${base}/plans/${plan.id}/approve`, "POST", {
                      expected_revision: plan.revision,
                    }),
                  )
                }
              >
                Approve plan
              </button>
              <button
                className="primary"
                disabled={busy || operationActive || plan.state !== "approved"}
                onClick={() =>
                  void mutate("Starting generation…", async () => {
                    await api(`${base}/generations`, "POST", {
                      request_key: crypto.randomUUID(),
                      plan_version_id: plan.id,
                      input_version_id: state.versions[0]?.id || null,
                    });
                    onGenerated();
                  })
                }
              >
                Generate agent
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
