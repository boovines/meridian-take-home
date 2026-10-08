import type {
  ImplementationVersion,
  Method,
} from "../../src/domain/engineering";
import { randomUUID } from "node:crypto";
import type { Database } from "../../src/server/database";
import { CanvasService } from "../../src/server/canvas/service";
import { ReviewService } from "../../src/server/reviews/review-service";
import { FreezeService } from "../../src/server/reviews/freeze-service";
import { PlanService } from "../../src/server/engineering/plan-service";
import { GenerationService } from "../../src/server/engineering/generation-service";
import { JobService } from "../../src/server/engineering/job-service";
import type { ArtifactService } from "../../src/server/artifacts/service";
import { BundleService } from "../../src/server/runtime/bundle-service";
import { RunService } from "../../src/server/runtime/run-service";
import {
  nodeInput,
  connectionInput,
  type NodeType,
} from "../../src/domain/canvas";
import { fixtureSources } from "./engineer";
export async function runtimeFixture(
  db: Database,
  artifacts: ArtifactService,
  types: NodeType[] = ["trigger", "human_approval", "outcome"],
  options?: {
    name: string;
    desired_outcome: string;
    instructions: Partial<Record<NodeType, string>>;
    methods?: Partial<Record<NodeType, Method>>;
  },
) {
  const canvas = new CanvasService(db),
    plans = new PlanService(db);
  const w = await canvas.create({
    name: options?.name || "Synthetic runtime verification",
    desired_outcome:
      options?.desired_outcome || "Review a packet and preview its report.",
  });
  const nodes = [];
  for (const type of types)
    nodes.push(
      await canvas.addNode(
        w.id,
        nodeInput.parse({
          type,
          title: type,
          instructions: options?.instructions[type] || `Complete ${type}.`,
        }),
      ),
    );
  for (let i = 0; i < nodes.length - 1; i++)
    await canvas.addConnection(
      w.id,
      connectionInput.parse({
        source_node_id: nodes[i].id,
        target_node_id: nodes[i + 1].id,
      }),
    );
  const review = new ReviewService(db),
    r = await review.start(w.id, { request_key: randomUUID() });
  await review.prepare(r.id);
  await review.publish(r.id, { findings: [] });
  const board = await canvas.load(w.id);
  await new FreezeService(db).freeze(w.id, {
    expected_content_revision: board.workflow.content_revision,
    acknowledge_unreviewed: false,
  });
  const plan = await plans.create(w.id, {
    request_key: randomUUID(),
    parent_plan_version_id: null,
  });
  for (const s of (await plans.state(w.id)).steps) {
    const method=options?.methods?.[nodes.find(n=>n.id===s.node_id)!.type];
    const selected=method?await plans.editStep(w.id,plan.id,s.node_id,{expected_revision:s.revision,selected_method:method}):s;
    await plans.editStep(w.id, plan.id, s.node_id, {
      expected_revision: selected.revision,
      approved: true,
    });
  }
  await plans.approve(w.id, plan.id, {
    expected_revision: (await plans.state(w.id)).plans[0].revision,
  });
  const jobs = new JobService(db),
    j = await jobs.startGeneration(w.id, {
      request_key: randomUUID(),
      plan_version_id: plan.id,
      input_version_id: null,
    });
  await new GenerationService(db, artifacts).run(
    j.id,
    {
      model: "fixture",
      generate: async (c) => fixtureSources(c.spec.board, c.steps),
      validate: async () => ({ engine: "fixture" }),
    },
    AbortSignal.timeout(10000),
  );
  const version = (await plans.state(w.id))
    .versions[0] as unknown as ImplementationVersion;
  const bundle = await new BundleService(db).create(w.id, {
    source_kind: "fixture",
    shipment_reference: "SYNTHETIC-001",
    manifest: {
      input: { shipment: "SYNTHETIC-001" },
      message_ids: [],
      artifacts: [],
    },
  });
  const runs = new RunService(db),
    started = await runs.start(w.id, {
      request_key: randomUUID(),
      implementation_version_id: version.id,
      input_bundle_id: String(bundle.id),
      rerun_of_id: null,
    });
  const context = (await runs.prepare(started.job.id))!;
  return {
    w,
    nodes,
    board,
    plan,
    version,
    bundle,
    runs,
    ...started,
    ...context,
  };
}
