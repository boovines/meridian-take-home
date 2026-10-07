import { describe, it, expect } from "vitest";
import { body } from "../src/server/http";
import { workflowInput,nodePatch,connectionPatch,workflowPatch } from "../src/domain/canvas";
describe("request boundary", () => {
  it('preserves omitted fields instead of applying create defaults to a patch',()=>{
    expect(nodePatch.parse({expected_revision:1,instructions:'Updated requirements'})).toEqual({expected_revision:1,instructions:'Updated requirements'});
    expect(nodePatch.parse({expected_revision:2,x:300,y:100})).toEqual({expected_revision:2,x:300,y:100});
    expect(connectionPatch.parse({expected_revision:1,condition_text:'Approved'})).toEqual({expected_revision:1,condition_text:'Approved'});
    expect(workflowPatch.parse({expected_revision:1,name:'New name'})).toEqual({expected_revision:1,name:'New name'});
  });
  it("accepts the public host when Next uses an internal hostname", async () => {
    const request = new Request("http://localhost:3100/api/workflows", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:3100", host: "127.0.0.1:3100" },
      body: JSON.stringify({ name: "Receiving" }),
    });
    expect(await body(request, workflowInput)).toEqual({
      name: "Receiving",
      desired_outcome: "",
    });
  });
  it("rejects a browser change from another origin", async () => {
    const request = new Request("http://localhost/api/workflows", {
      method: "POST",
      headers: { origin: "https://another-site.example", host: "localhost" },
      body: '{"name":"Receiving"}',
    });
    await expect(body(request, workflowInput)).rejects.toMatchObject({
      code: "ORIGIN_MISMATCH",
    });
  });
});
