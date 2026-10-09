import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { meteredOpenAIFetch } from "../src/server/integrations/openai-client";
import { captureInferenceTrace, inferenceStage, annotateInferenceTrace } from "../src/server/integrations/inference-trace";
import type { ProviderTrace } from "../src/domain/execution-audit";
import { DomainError } from "../src/domain/errors";
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });
const request = {method:"POST",body:JSON.stringify({model:"gpt-5.4",input:"private fixture text",max_output_tokens:100})};

it("records preflight, dispatch and settled usage without copying request contents",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"trace-meter-"));
  vi.stubEnv("INFERENCE_BUDGET_LEDGER",path.join(dir,"ledger"));vi.stubEnv("INFERENCE_BUDGET_USD","1");
  let trace: ProviderTrace | undefined;
  try {
    await captureInferenceTrace(()=>meteredOpenAIFetch(async url => Response.json(String(url).endsWith("/input_tokens") ? {input_tokens:20} : {model:"gpt-5.4",service_tier:"default",usage:{input_tokens:20,output_tokens:5}}),true)("https://api.openai.com/v1/responses",request),t=>{trace=t;});
    expect(trace?.stages.map(s=>s.stage)).toEqual(["preflight","reservation","response","reconciliation"]);
    expect(trace?.stages.every(s=>s.outcome==="completed")).toBe(true);
    const charge=JSON.parse(await readFile(path.join(dir,"ledger"),"utf8")).charges[0];
    expect(trace).toMatchObject({reservation_id:charge.id,actual_usd:charge.actual_usd,input_tokens:20,output_tokens:5,http_status:200});
    expect(JSON.stringify(trace)).not.toContain("private fixture text");
  }finally{await rm(dir,{recursive:true,force:true});}
});

it("separates simultaneous interactions and snapshots failures before reuse",async()=>{
  const saved:ProviderTrace[]=[];
  await Promise.all([1,2].map(n=>captureInferenceTrace(async()=>{
    annotateInferenceTrace({input_tokens:n});
    await inferenceStage("response",async()=>{await new Promise(r=>setTimeout(r,n));if(n===2)throw new DomainError(503,"MODEL_RESPONSE_TIMEOUT","private error text");});
  },t=>saved.push(t)).catch(()=>{})));
  expect(saved.map(t=>t.input_tokens).sort()).toEqual([1,2]);
  expect(saved.find(t=>t.input_tokens===2)?.stages[0]).toMatchObject({outcome:"failed",code:"MODEL_RESPONSE_TIMEOUT"});
  expect(saved.find(t=>t.input_tokens===1)?.stages[0].outcome).toBe("completed");
  expect(JSON.stringify(saved)).not.toContain("private error text");
});

it("does not impose extraction's response deadline on code generation or repair",async()=>{
  vi.stubEnv("INFERENCE_BUDGET_LEDGER","");vi.stubEnv("INFERENCE_BUDGET_USD","");vi.useFakeTimers();
  let finished=false;
  const promise=meteredOpenAIFetch(async()=>{await new Promise(r=>setTimeout(r,200000));return Response.json({ok:true});})("https://api.openai.com/v1/responses",request).then(r=>{finished=true;return r;});
  await vi.advanceTimersByTimeAsync(180001);expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(20000);expect((await promise).ok).toBe(true);
});
