// Sanitized live-provider smoke test. Uses an ephemeral database, never a saved
// workflow or mailbox. Run explicitly with OPENAI_API_KEY and a scoping model.
import { randomUUID } from "node:crypto";
import { createDatabase, migrate } from "../src/server/database";
import { CanvasService } from "../src/server/canvas/service";
import { ScopingService } from "../src/server/scoping/service";
import { ScaffoldApplyService } from "../src/server/scoping/apply-service";
import { scopeWithOpenAI } from "../src/server/integrations/openai-scoping";
import { scopeReady } from "../src/domain/scoping";
import { validateGraph } from "../src/domain/validate-graph";
import { FreezeService } from "../src/server/reviews/freeze-service";
if (!process.env.OPENAI_API_KEY)
  throw new Error(
    "Configure OPENAI_API_KEY for this explicit live smoke test.",
  );
const db = await createDatabase();
try {
  await migrate(db);
  const canvas = new CanvasService(db),
    service = new ScopingService(db);
  const w = await canvas.create({
    name: "Sanitized scoping smoke",
    desired_outcome: "",
  });
  await service.state(w.id);
  await service.saveNote(w.id, {
    expected_revision: 1,
    note: "An employee manually submits a plain-text request to draft a customer response. One run processes one request. Read the supplied request and draft a response using only that text. A named process owner must approve the draft before the outcome. If rejected, use their feedback to revise and ask the same owner again; this loop continues until approval. If information is missing, ask that owner to supply it before drafting; wait for their response, then resume drafting. After approval, show the approved text in a preview; never send email. No parallel paths, automatic sending, external document access or additional approvers are required. Retention length is unknown; keep it as an explicit nonstructural review question rather than inventing a policy. All other scope and routing are confirmed.",
  });
  async function turn(action: "start" | "answer" | "preview", body = "") {
    const s = (await service.state(w.id)).session;
    const op = await service.request(w.id, {
      action,
      body,
      request_key: randomUUID(),
      expected_revision: s.revision,
      expected_note_revision: s.note_revision,
    });
    await service.prepare(op.id);
    const result = await scopeWithOpenAI(op, AbortSignal.timeout(110000));
    await service.publish(op.id, result);
    return service.state(w.id);
  }
  let state = await turn("start");
  let version = state.versions.find(
    (v) => v.id === state.session.current_scope_id,
  )!;
  if (!("scope" in version.data)) throw new Error("Missing scope");
  if (!scopeReady(version.data.scope)) {
    console.log(
      JSON.stringify({ stage: "clarification", scope: version.data.scope }),
    );
    state = await turn(
      "answer",
      "The single process owner is the human assigned to the request at submission. Missing information pauses for that same owner's reply, then resumes drafting. The request text and owner's answers are the only inputs. The approved preview is the end of this process. Retention stays unresolved for normal review. These routing choices are confirmed; no other steps are in scope.",
    );
    version = state.versions.find(
      (v) => v.id === state.session.current_scope_id,
    )!;
  }
  if (!("scope" in version.data) || !scopeReady(version.data.scope))
    throw new Error(
      "Live interview still needs consequential clarification; do not claim readiness.",
    );
  state = await turn("preview");
  const board = await new ScaffoldApplyService(db).apply(w.id, {
    preview_id: state.session.current_preview_id!,
    expected_revision: state.session.revision,
    expected_workflow_revision: w.revision,
    request_key: randomUUID(),
  });
  if (
    validateGraph(board).length ||
    !board.nodes.some((n) => n.type === "human_approval")
  )
    throw new Error("Invalid scaffold or missing required approval.");
  const readiness = await new FreezeService(db).readiness(w.id);
  if (readiness.completed_review_id)
    throw new Error("Scoping incorrectly counted as review.");
  console.log(
    JSON.stringify(
      {
        passed: true,
        model:
          process.env.OPENAI_SCOPING_MODEL ||
          process.env.OPENAI_REVIEW_MODEL ||
          "gpt-5.4-mini",
        nodes: board.nodes.map((n) => ({
          type: n.type,
          title: n.title,
          instructions: n.instructions,
        })),
        paths: board.connections.length,
        pending_review_questions: readiness.open_findings.map((f) => f.title),
        normal_review_required: true,
      },
      null,
      2,
    ),
  );
} finally {
  await db.close();
}
