import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { Project } from "../src/domain/project";
import type { RepairContext } from "../src/server/repairs/generation-service";
const state = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("../src/server/integrations/openai-client", () => ({ openai: () => state.model }));
vi.mock("../src/server/repairs/evidence", () => ({ repairPrompt: () => "Locked test context" }));
import { repairProjectSources } from "../src/server/integrations/openai-repair";

it.each(["application/pdf", "text/plain"])("feeds %s evidence back to the model, then replays a proposed repair before the final structured patch", async (media) => {
  const id = randomUUID();
  const node = randomUUID();
  const answer = { diagnosis: { summary: "Source inspected", affected_node_ids: [], changes: [] }, project: { status: "needs_attention", explanation: "Missing trusted source detail", steps: [] } };
  let count = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    count++;
    return {
      content: count <= 3
        ? [{ type: "tool-call", toolCallId: `read-${count}`, toolName: "inspectDocument", input: JSON.stringify({ artifact_id: id }) }]
        : count <= 5 ? [{ type: "tool-call", toolCallId: `replay-${count}`, toolName: "replay_step", input: JSON.stringify({ recorded_input_id: id, candidate_patch: { node_id: node, source_lines: ["export function run() {}"] } }) }]
        : [{ type: "text", text: JSON.stringify(answer) }],
      finishReason: { unified: count <= 5 ? "tool-calls" : "stop", raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    };
  } });
  state.model = model;
  const bytes = Buffer.from(media === "application/pdf" ? "%PDF-1.7\nfixture" : "Verified source text");
  const read = vi.fn(async () => ({ artifact_id: id, name: "source", media_type: media, bytes }));
  const replay = vi.fn(async () => ({ diagnostic_only: true, changed_from_recording: false }));
  const result = await repairProjectSources({} as RepairContext, {} as Project, AbortSignal.timeout(10000), [], read, async()=>({}), replay);
  expect(result).toEqual(answer);
  expect(read).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenCalledWith(id, undefined);
  expect(replay).toHaveBeenCalledTimes(2);
  expect(model.doGenerateCalls).toHaveLength(6);
  expect(JSON.stringify(model.doGenerateCalls[4].prompt)).toContain("changed_from_recording");
  expect(model.doGenerateCalls[5].toolChoice).toEqual({ type: "none" });
  const evidence = model.doGenerateCalls[1].prompt.find(message => message.role === "tool");
  expect(JSON.stringify(evidence)).toContain(id);
  expect(JSON.stringify(evidence)).toContain(media === "application/pdf" ? "application/pdf" : "Verified source text");
});

it('passes an exact audit subtree to repair without exposing unrelated artifacts', async()=>{
  const id=randomUUID();
  const answer={diagnosis:{summary:'Inspect consumer after model response',affected_node_ids:[],changes:[]},project:{status:'needs_attention',explanation:'Evidence needs review',steps:[]}};
  let count=0;
  const model=new MockLanguageModelV4({doGenerate:async()=>({
    content:++count===1?[{type:'tool-call',toolCallId:'audit',toolName:'inspectExecutionAudit',input:JSON.stringify({event_id:id,path:['records','0']})}]:[{type:'text',text:JSON.stringify(answer)}],
    finishReason:{unified:count===1?'tool-calls':'stop',raw:undefined},
    usage:{inputTokens:{total:1,noCache:1,cacheRead:undefined,cacheWrite:undefined},outputTokens:{total:1,text:1,reasoning:undefined}},warnings:[],
  })});
  state.model=model;
  const readAudit=vi.fn(async()=>({event_id:id,kind:'model_response',value:{date:'2026-10-09'},truncated:false}));
  const readDocument=vi.fn();
  expect(await repairProjectSources({} as RepairContext,{} as Project,AbortSignal.timeout(10000),[],readDocument,readAudit)).toEqual(answer);
  expect(readAudit).toHaveBeenCalledWith(id,['records','0']);
  expect(readDocument).not.toHaveBeenCalled();
  expect(JSON.stringify(model.doGenerateCalls[1].prompt.find(m=>m.role==='tool'))).toContain('2026-10-09');
});


it("passes selected original page numbers to the source reader and back to the model", async () => {
  const id = randomUUID();
  const answer = { diagnosis: { summary: "Ambiguous source", affected_node_ids: [], changes: [] }, project: { status: "needs_attention", explanation: "Needs source confirmation", steps: [] } };
  let calls = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => ({
    content: ++calls === 1 ? [{ type: "tool-call", toolCallId: "pages", toolName: "inspectDocument", input: JSON.stringify({ artifact_id: id, pages: [44] }) }] : [{ type: "text", text: JSON.stringify(answer) }],
    finishReason: { unified: calls === 1 ? "tool-calls" : "stop", raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
  }) });
  state.model = model;
  const read = vi.fn(async () => ({ artifact_id: id, name: "selected.pdf", media_type: "application/pdf", bytes: Buffer.from("%PDF-1.7 fixture"), source_page_numbers: [44] }));
  await repairProjectSources({} as RepairContext, {} as Project, AbortSignal.timeout(10000), [], read, async () => ({}));
  expect(read).toHaveBeenCalledWith(id, [44]);
  expect(JSON.stringify(model.doGenerateCalls[1].prompt.find(m => m.role === "tool"))).toContain("original source pages 44");
});
