import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode, type WorkflowBundle } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";
import { cancellationSignal, heartbeat } from "@temporalio/activity";
import { nodeInput } from "../src/domain/canvas";
import { WORKER_ACTIVITY_CONCURRENCY } from "../src/domain/runtime-policy";

let env: TestWorkflowEnvironment, workflowBundle: WorkflowBundle;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  workflowBundle = await bundleWorkflowCode({ workflowsPath: path.resolve("src/worker/workflows.ts") });
}, 120000);
afterAll(async () => { await env?.teardown(); });

async function harness(options: {
  concurrency?: number;
  kind?: "step" | "workflow";
  work: (id: string) => Promise<void>;
  buildFailure?: boolean;
  fatalBegin?: string;
  deadlineMs?: number;
}) {
  const taskQueue = `parallel-eval-${randomUUID()}`;
  const events: string[] = [];
  const ended: { error?: {code: string}; cancelled: boolean }[] = [];
  const node = { ...nodeInput.parse({type:"trigger", title:"Synthetic input"}), id:randomUUID() };
  const worker = await Worker.create({
    connection:env.nativeConnection, taskQueue, workflowBundle,
    maxConcurrentActivityTaskExecutions:WORKER_ACTIVITY_CONCURRENCY,
    maxHeartbeatThrottleInterval:20,
    activities: {
      prepareEvaluation: async () => ({
        evaluation_id:randomUUID(), result_ids:["0","1","2","3","4"],
        deadline_at:new Date(Date.now()+(options.deadlineMs ?? 60000)).toISOString(),
        ...(options.concurrency ? {case_concurrency:options.concurrency} : {}),
      }),
      checkEvaluationBuild: async () => options.buildFailure
        ? {ok:false,error:{code:"PROJECT_BUILD_FAILED",category:"implementation",message:"Synthetic build error"}} : {ok:true},
      beginEvaluationCase: async (id:string) => {
        events.push(`begin:${id}`);
        if(options.fatalBegin===id) throw ApplicationFailure.nonRetryable("Synthetic persistence error");
        return {kind:options.kind ?? (Number(id)%2 ? "workflow":"step"),run_id:`${taskQueue}:${id}`};
      },
      evaluateStepCase: options.work,
      prepareCaseExecution: async (id:string) => ({
        run:{id}, definition:{board:{nodes:[node],connections:[]},methods:{[node.id]:"code"},limits:{step_attempts:10,active_ms:60000}},
      }),
      executeOccurrence: async (data:{run_id:string}) => {
        await options.work(data.run_id.split(":").at(-1)!);
        return {kind:"complete",step_id:randomUUID(),connection_ids:[]};
      },
      projectExecution: async () => {},
      endCaseExecution: async (id:string,result:{status:string}) => {events.push(`child:${id.split(":").at(-1)}:${result.status}`);},
      scoreWorkflowCase: async (id:string) => {events.push(`score:${id}`);},
      failEvaluationCase: async (id:string) => {events.push(`error:${id}`);},
      endEvaluation: async (_id:string,error: {code:string}|undefined,cancelled:boolean) => {
        events.push("end"); ended.push({error,cancelled});
      },
    },
  });
  return { worker, taskQueue, events, ended };
}

it("keeps two independent cases busy, refills a free slot, isolates errors and replays", async () => {
  const release = Promise.withResolvers<void>(), others = Promise.withResolvers<void>();
  let active=0, peak=0, completed=0;
  const calls:string[]=[];
  const h=await harness({concurrency:2,work:async(id)=>{
    calls.push(id); peak=Math.max(peak,++active);
    try {
      if(id==="0") await release.promise;
      else await delay(10);
      if(id==="2") throw ApplicationFailure.nonRetryable("Synthetic case error");
    } finally {
      active--;
      if(id!=="0" && ++completed===4) others.resolve();
    }
  }});
  await h.worker.runUntil(async()=>{
    const handle=await env.client.workflow.start("evaluateSuite",{workflowId:randomUUID(),taskQueue:h.taskQueue,args:[randomUUID()]});
    try {
      await others.promise;
      expect(active).toBe(1); // The slow case remains active while all other slots refill.
      expect(h.events).not.toContain("end");
      expect(peak).toBe(2);
    } finally {release.resolve();}
    await handle.result();
    expect(calls.slice().sort()).toEqual(["0","1","2","3","4"]);
    expect(h.events.filter(e=>e.startsWith("error:"))).toEqual(["error:2"]);
    expect(h.events.filter(e=>e.startsWith("score:"))).toEqual(["score:1","score:3"]);
    expect(h.ended).toEqual([{error:undefined,cancelled:false}]);
    await Worker.runReplayHistory({workflowBundle},await handle.fetchHistory());
  });
},30000);

it("replays historical activity results without concurrency and keeps them sequential",async()=>{
  let active=0,peak=0;
  const calls:string[]=[];
  const h=await harness({kind:"step",work:async(id)=>{calls.push(id);peak=Math.max(peak,++active);await delay(10);active--;}});
  await h.worker.runUntil(async()=>{
    const handle=await env.client.workflow.start("evaluateSuite",{workflowId:randomUUID(),taskQueue:h.taskQueue,args:[randomUUID()]});
    await handle.result();
    expect(peak).toBe(1);expect(calls).toEqual(["0","1","2","3","4"]);
    await Worker.runReplayHistory({workflowBundle},await handle.fetchHistory());
  });
});

it.each(["step","workflow"] as const)("cancels both active %s cases before finishing and leaves queued cases untouched",async(kind)=>{
  const started=Promise.withResolvers<void>();let active=0,exited=0;
  const h=await harness({concurrency:2,kind,work:async()=>{
    const signal=cancellationSignal(), pulse=setInterval(()=>heartbeat(),20);
    heartbeat(); if(++active===2)started.resolve();
    try {await delay(60000,undefined,{signal});}
    finally {clearInterval(pulse);await delay(50);exited++;}
  }});
  await h.worker.runUntil(async()=>{
    const handle=await env.client.workflow.start("evaluateSuite",{workflowId:randomUUID(),taskQueue:h.taskQueue,args:[randomUUID()]});
    await started.promise;await handle.cancel();await handle.result();
    expect(exited).toBe(2);
    expect(h.events.filter(e=>e.startsWith("begin:")).sort()).toEqual(["begin:0","begin:1"]);
    expect(h.ended).toEqual([{error:undefined,cancelled:true}]);
    if(kind==="workflow")expect(h.events.filter(e=>e.includes(":cancelled"))).toHaveLength(2);
    expect(h.events.at(-1)).toBe("end");
  });
},20000);

it("stops at a shared build failure without launching any case",async()=>{
  const h=await harness({concurrency:2,buildFailure:true,work:async()=>{throw new Error("Must not run");}});
  await h.worker.runUntil(()=>env.client.workflow.execute("evaluateSuite",{workflowId:randomUUID(),taskQueue:h.taskQueue,args:[randomUUID()]}));
  expect(h.events).toEqual(["end"]);expect(h.ended[0].error?.code).toBe("PROJECT_BUILD_FAILED");
});

it("drains siblings after a fatal scheduling error before publishing failure",async()=>{
  const h=await harness({concurrency:2,kind:"step",fatalBegin:"1",work:async()=>{
    const signal=cancellationSignal(),pulse=setInterval(()=>heartbeat(),20);heartbeat();
    try {await delay(60000,undefined,{signal});}finally {clearInterval(pulse);}
  }});
  await h.worker.runUntil(async()=>{
    await expect(env.client.workflow.execute("evaluateSuite",{workflowId:randomUUID(),taskQueue:h.taskQueue,args:[randomUUID()]})).rejects.toThrow();
  });
  expect(h.events.filter(e=>e.startsWith("begin:")).sort()).toEqual(["begin:0","begin:1"]);
  expect(h.ended).toEqual([{error:expect.objectContaining({code:"EVALUATION_INTERRUPTED"}),cancelled:false}]);
});

it("the deadline stops both cases and never reports success",async()=>{
  let exited=0;
  const h=await harness({concurrency:2,kind:"step",deadlineMs:2000,work:async()=>{
    const signal=cancellationSignal(),pulse=setInterval(()=>heartbeat(),20);heartbeat();
    try{await delay(60000,undefined,{signal});}finally{clearInterval(pulse);exited++;}
  }});
  await h.worker.runUntil(()=>env.client.workflow.execute("evaluateSuite",{workflowId:randomUUID(),taskQueue:h.taskQueue,args:[randomUUID()]}));
  expect(exited).toBe(2);
  expect(h.events.filter(e=>e.startsWith("begin:")).sort()).toEqual(["begin:0","begin:1"]);
  expect(h.ended).toEqual([{error:expect.objectContaining({code:"EVALUATION_LIMIT"}),cancelled:false}]);
});
