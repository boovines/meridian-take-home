import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, expect, it } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { ArtifactService } from "../src/server/artifacts/service";
import { LocalObjectStore } from "../src/server/artifacts/storage";
import { runtimeFixture } from "./fixtures/runtime";
import { SuiteService } from "../src/server/evaluations/suite-service";
import { EvaluationService } from "../src/server/evaluations/evaluation-service";
import { finishEvaluationWithRepair } from "../src/server/evaluations/automatic-repair";
import { caseInput } from "../src/domain/evaluation";
import { JobService } from "../src/server/engineering/job-service";
let db: Database, artifacts: ArtifactService, dir: string;
beforeAll(async () => {
  db = await createDatabase(); await migrate(db);
  dir = await mkdtemp(path.join(os.tmpdir(), "automatic-repair-"));
  artifacts = new ArtifactService(db, new LocalObjectStore(dir));
});
afterAll(async () => { await db.close(); await rm(dir, {recursive:true, force:true}); });
async function fixture(auto = true) {
  const f = await runtimeFixture(db, artifacts, ["trigger", "outcome"]);
  await f.runs.finish(f.job.id, {status:"cancelled"});
  const suites = new SuiteService(db), evals = new EvaluationService(db);
  const suite = await suites.create(f.w.id, {request_key:randomUUID(), name:"Trusted", parent_suite_version_id:null});
  const c = await suites.addCase(f.w.id, suite.id, caseInput.parse({case_key:"count", name:"Count", kind:"step", node_id:f.nodes[1].id, input_data:{input:{count:1},steps:{}}, assertions:[{key:"count",label:"Count",path:["count"],expected:1}]}));
  await suites.verifyCase(f.w.id,suite.id,c.id,{expected_revision:c.revision});
  await suites.lock(f.w.id,suite.id,{expected_revision:(await suites.state(f.w.id)).suites[0].revision});
  const request={request_key:randomUUID(),implementation_version_id:f.version.id,suite_version_id:suite.id,...(auto?{auto_repair:true}:{})};
  const started=await evals.start(f.w.id,request);
  const ready=(await evals.prepare(started.job.id))!;
  return {f,suites,evals,suite,request,...started,result:ready.results[0]};
}
it("atomically hands a failed evaluation to exactly one bounded session, including completion retries",async()=>{
  const f=await fixture();
  await f.evals.beginCase(f.result.id); await f.evals.recordCase(f.result.id,{actual:{count:2}});
  const [a,b]=await Promise.all([finishEvaluationWithRepair(db,f.job.id),finishEvaluationWithRepair(db,f.job.id)]);
  expect(a?.id).toBe(b?.id); expect(a?.kind).toBe("repair");
  const sessions=(await db.query("SELECT * FROM repair_sessions WHERE workflow_id=$1",[f.f.w.id])).rows;
  expect(sessions).toHaveLength(1); expect(sessions[0].attempt_limit).toBe(3);
  expect(sessions[0].initial_evaluation_id).toBe(f.evaluation.id);
  const active=(await db.query("SELECT kind FROM workflow_jobs WHERE workflow_id=$1 AND status IN ('queued','running')",[f.f.w.id])).rows;
  expect(active).toEqual([{kind:"repair"}]);
  await expect(f.evals.start(f.f.w.id,{...f.request,auto_repair:false})).rejects.toMatchObject({code:"REQUEST_REUSED"});
});
it.each(["pass","manual","infrastructure","cancel","revision","build"])("handles %s without unbounded continuation",async(mode)=>{
  const f=await fixture(mode!=="manual");
  if(mode==="revision") await f.suites.create(f.f.w.id,{request_key:randomUUID(),name:"Corrected",parent_suite_version_id:f.suite.id});
  if(mode!=="build") {await f.evals.beginCase(f.result.id); await f.evals.recordCase(f.result.id, mode==="infrastructure"?{error:{category:"infrastructure",code:"UNAVAILABLE",message:"Service unavailable"}}:{actual:{count:mode==="pass"?1:2}});}
  if(mode==="cancel") await new JobService(db).requestCancel(f.f.w.id,f.job.id);
  const next=await finishEvaluationWithRepair(db,f.job.id,mode==="build"?{category:"implementation",code:"PROJECT_BUILD_FAILED",message:"Syntax error"}:undefined);
  expect(Boolean(next)).toBe(mode==="build");
  if(mode==="infrastructure"||mode==="revision") expect((await db.query("SELECT status,phase FROM workflow_jobs WHERE id=$1",[f.job.id])).rows[0]).toEqual({status:"failed",phase:"automatic repair needs attention"});
  if(mode==="revision") await expect(f.evals.start(f.f.w.id,{...f.request,request_key:randomUUID()})).rejects.toMatchObject({code:"SUITE_CHANGED"});
});

it("keeps typed worker validation failures repairable after Temporal wrapping", async()=>{
  const { ApplicationFailure }=await import("@temporalio/common");
  const { describeExecutionFailure }=await import("../src/worker/execution-failure");
  const f=await fixture(); await f.evals.beginCase(f.result.id);
  const typed=ApplicationFailure.create({type:"EXTRACTION_EVIDENCE_INVALID",message:"Source citation is invalid",nonRetryable:true,details:[{failure_category:"implementation"}]});
  await f.evals.recordCase(f.result.id,{error:describeExecutionFailure(new Error("Activity failed",{cause:typed}))});
  const next=await finishEvaluationWithRepair(db,f.job.id);
  expect(next?.kind).toBe("repair");
  expect((await db.query("SELECT failure_category FROM evaluation_case_results WHERE id=$1",[f.result.id])).rows[0].failure_category).toBe("implementation");
  expect((await f.suites.state(f.f.w.id)).cases[0].assertions[0].expected).toBe(1);
});
