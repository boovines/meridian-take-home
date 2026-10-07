"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight, Plus, Workflow as WorkflowIcon } from "lucide-react";
import Workspace from "./shell/workspace";
import { Dialog } from "./dialog";
import { api, errorMessage } from "@/lib/api";
import type { Workflow } from "@/domain/canvas";
export function WorkflowList() {
  const router = useRouter();
  const [items, setItems] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true),
    [creating, setCreating] = useState(false),
    [error, setError] = useState("");
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [goal, setGoal] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      setItems(await api<Workflow[]>("/api/workflows"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let active = true;
    api<Workflow[]>("/api/workflows")
      .then((w) => {
        if (active) setItems(w);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function create(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError("");
    try {
      const w = await api<Workflow>("/api/workflows", "POST", {
        name,
        desired_outcome: goal,
      });
      router.push(`/workflows/${w.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setCreating(false);
    }
  }
  return (
    <Workspace
      title="Your workflows"
      subtitle="Turn the way you work into a process you can trust."
      actions={
        <button className="primary" onClick={() => setOpen(true)}>
          <Plus size={16} /> Create workflow
        </button>
      }
    >
      <main className="workflow-list">
        {error && (
          <div className="error-banner" role="alert">
            {error} <button onClick={() => void load()}>Retry</button>
          </div>
        )}
        <div className="section-heading">
          <span>PROCESS LIBRARY</span>
          <span>{items.length} workflows</span>
        </div>
        {loading ? (
          <p role="status">Loading workflows…</p>
        ) : items.length === 0 ? (
          <div className="empty-library">
            <WorkflowIcon size={32} />
            <h2>Start with the process you know.</h2>
            <p>
              Map what happens, who is involved, and what a successful outcome
              looks like.
            </p>
            <button onClick={() => setOpen(true)}>
              Create your first workflow <ArrowUpRight size={15} />
            </button>
          </div>
        ) : (
          <div className="workflow-grid">
            {items.map((w) => (
              <Link
                href={`/workflows/${w.id}`}
                className="workflow-card"
                key={w.id}
              >
                <div className="card-top">
                  <WorkflowIcon size={21} />
                  <span className={`status-pill ${w.state}`}>{w.state}</span>
                </div>
                <h2>{w.name}</h2>
                <p>
                  {w.desired_outcome ||
                    "Add the outcome this process should achieve."}
                </p>
                <div className="card-bottom">
                  <span>
                    Updated{" "}
                    {new Date(w.updated_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <ArrowUpRight size={18} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
      {open && (
        <Dialog labelledBy="create-title" onClose={() => setOpen(false)}>
          <span className="eyebrow">New workflow</span>
          <h2 id="create-title">What are we working on?</h2>
          {error && (
            <div role="alert" className="inline-error">
              {error}
            </div>
          )}
          <form onSubmit={create}>
            <label>
              Workflow name
              <input
                autoFocus
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Import receiving"
              />
            </label>
            <label>
              What should this workflow accomplish?
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                maxLength={10000}
                placeholder="Describe a successful outcome. You can refine this later."
                rows={4}
              />
            </label>
            <div className="form-actions">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={creating}
              >
                Cancel
              </button>
              <button className="primary" disabled={creating || !name.trim()}>
                {creating ? "Creating…" : "Create workflow"}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </Workspace>
  );
}
