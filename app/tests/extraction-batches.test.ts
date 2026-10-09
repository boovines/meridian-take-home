import {randomUUID} from "node:crypto";
import {expect,it,vi} from "vitest";
import {invokeApprovedStep} from "../src/server/runtime/invoke-step";
import type {Project} from "../src/domain/project";
import type {ExtractionRequest} from "../src/domain/extraction";
import type {Json} from "../src/domain/runtime";
import type {ReasoningDocument} from "../src/server/runtime/documents";

const ids=Array.from({length:21},()=>randomUUID());
const batch=(documents:string[]):ExtractionRequest=>({kind:"extract",instructions:"Read reference",data:{},document_ids:documents,
  output_schema:{type:"object",properties:{reference:{type:"string"}},required:["reference"],additionalProperties:false},critical_paths:[["reference"]]});
const response=(id:string)=>({data:{reference:"sample"},fields:[{path:["reference"],raw_value:"sample",normalized_value:"sample",status:"found",evidence:[{artifact_id:id,page:1,text:"sample"}],explanation:null}]});
const read=async(ids:string[]):Promise<ReasoningDocument[]>=>ids.map(id=>({artifact_id:id,name:"source.txt",media_type:"text/plain",bytes:Buffer.from("sample")}));
function fixture(options:{badBatch?:number;abortAfter?:number;method?:"code"|"agent";batches?:ExtractionRequest[]}={}) {
  const controller=new AbortController();
  const events:{kind:string;payload:unknown;summary:unknown}[]=[];
  const selected:string[][]=[];
  let finalContext:Record<string,Json>|undefined;
  const invoke=vi.fn(async(_p:Project,_id:string,context:Record<string,Json>)=>{
    if(Object.hasOwn(context,"tool_result")){finalContext=context;return {kind:"complete",output:context.tool_result,matching_connection_ids:[]};}
    return {kind:"extract_batch",batches:options.batches??[batch(ids.slice(0,20)),batch(ids.slice(20))]};
  });
  const extract=vi.fn(async(request:ExtractionRequest)=>{
    selected.push(request.document_ids);
    if(options.abortAfter===selected.length)controller.abort();
    return options.badBatch===selected.length ? {...response(request.document_ids[0]),fields:[]} : response(request.document_ids[0]);
  });
  const run=()=>invokeApprovedStep({} as Project,randomUUID(),options.method??"agent",{}, {invoke,extract,reason:async()=>({})},controller.signal,read,async(kind,payload,summary)=>{events.push({kind,payload,summary});});
  return {run,invoke,extract,events,selected,context:()=>finalContext};
}
it("reads all 21 documents in two bounded batches and postprocesses only validated results",async()=>{
  const f=fixture();await f.run();
  expect(f.selected.flat()).toEqual(ids);expect(f.extract).toHaveBeenCalledTimes(2);expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(f.context()?.tool_result).toEqual({batches:[{reference:"sample"},{reference:"sample"}]});
  expect(f.context()?.extraction_evidence).toMatchObject({batches:[[{path:["reference"]}],[{path:["reference"]}]]});
  expect(f.events.filter(e=>e.kind==="model_request").map(e=>(e.summary as {batch_index:number}).batch_index)).toEqual([0,1]);
});
it("retains the invalid batch's diagnostics and never publishes partial extraction",async()=>{
  const f=fixture({badBatch:2});await expect(f.run()).rejects.toMatchObject({code:"EXTRACTION_EVIDENCE_INVALID"});
  expect(f.invoke).toHaveBeenCalledTimes(1);expect(f.events.at(-1)).toMatchObject({kind:"failure",summary:{batch_index:1,evidence_issues:[{path:["reference"]}]}});
});
it("does not start a subsequent batch or postprocess after cancellation",async()=>{
  const f=fixture({abortAfter:1});await expect(f.run()).rejects.toBeDefined();expect(f.extract).toHaveBeenCalledTimes(1);expect(f.invoke).toHaveBeenCalledTimes(1);
});
it("rejects batch requests from Code methods",async()=>{
  const f=fixture({method:"code"});await expect(f.run()).rejects.toMatchObject({code:"METHOD_VIOLATION"});expect(f.extract).not.toHaveBeenCalled();
});
it.each([6,0])("rejects %s batches before any provider work",async count=>{
  const f=fixture({batches:Array.from({length:count},()=>batch([ids[0]]))});await expect(f.run()).rejects.toBeDefined();expect(f.extract).not.toHaveBeenCalled();
});
it("validates every batch schema before starting paid work",async()=>{
  const f=fixture({batches:[batch([ids[0]]),{...batch([ids[1]]),output_schema:{$ref:"https://invalid.test"}}]});
  await expect(f.run()).rejects.toMatchObject({code:"EXTRACTION_SCHEMA_INVALID"});expect(f.extract).not.toHaveBeenCalled();
});

it("retains every batch interaction without silently truncating at the former audit limit",async()=>{
  const f=fixture({batches:ids.slice(0,5).map(id=>batch([id]))});await f.run();
  expect(f.events.map(e=>e.kind)).toEqual(["initial_output",...Array.from({length:5},()=>["model_request","model_response"]).flat(),"final_output"]);
});

it("rejects evidence citing a different batch even if the source is in the overall packet",async()=>{
  let calls=0;
  await expect(invokeApprovedStep({} as Project,randomUUID(),"agent",{}, {
    invoke:async()=>({kind:"extract_batch",batches:[batch([ids[0]]),batch([ids[1]])]}),
    reason:async()=>({}),extract:async()=>{calls++;return response(ids[1]);},
  },AbortSignal.timeout(1000),read)).rejects.toMatchObject({code:"EXTRACTION_EVIDENCE_INVALID"});
  expect(calls).toBe(1);
});
