import { test, expect } from "@playwright/test";

test("selects all pages and captures inferred packets separately, retaining successes on retry", async ({page}) => {
  const wid=crypto.randomUUID(), version=crypto.randomUUID(), spec=crypto.randomUUID();
  const ids=Array.from({length:14},(_,i)=>i.toString(16).padStart(16,"0"));
  const emails=ids.map((id,i)=>({id,thread_id:id,subject:`Email ${i+1}`,sender:"demo@example.test",received_at:"2026-01-01T00:00:00Z"}));
  const packets: {id:string;shipment_reference:string;source_kind:string;created_at:string}[]=[];
  let firstCalls=0, secondCalls=0;
  await page.route(`**/api/workflows/${wid}/**`,async route=>{
    const u=new URL(route.request().url()), p=u.pathname;
    if(p.endsWith("/engineering")) return route.fulfill({json:{workflow:{id:wid,name:"Packet capture demo",desired_outcome:"Read one shipment"},specs:[{id:spec,version_number:1,created_at:"2026-01-01T00:00:00Z"}],spec:{id:spec,version_number:1,board:{nodes:[],connections:[]}},plans:[],steps:[],versions:[{id:version,version_number:1,created_at:"2026-01-01T00:00:00Z"}],jobs:[]}});
    if(p.endsWith("/input-bundles"))return route.fulfill({json:packets});
    if(p.endsWith("/runs"))return route.fulfill({json:{initial_manual_version_id:version,runs:[],steps:[],human_requests:[]}});
    if(p.endsWith("/gmail/messages"))return route.fulfill({json:{messages:u.searchParams.has("page_token")?emails.slice(10):emails.slice(0,10),next_page_token:u.searchParams.has("page_token")?null:"page-two"}});
    if(p.endsWith("/gmail/prepare")){
      expect(route.request().postDataJSON().message_ids).toEqual(ids);
      return route.fulfill({json:{groups:[{reference:"PACKET-A",message_ids:ids.slice(0,7),reason:"Explicit matching reference",evidence:{message_id:ids[0],quote:"Reference PACKET-A"}},{reference:"PACKET-B",message_ids:ids.slice(7),reason:"Explicit matching reference",evidence:{message_id:ids[7],quote:"Reference PACKET-B"}}],unresolved:[]}});
    }
    if(p.endsWith("/gmail/capture")){
      const data=route.request().postDataJSON();
      if(data.shipment_reference==="PACKET-A") {firstCalls++;expect(data.message_ids).toEqual(ids.slice(0,7));}
      else {secondCalls++;expect(data.message_ids).toEqual(ids.slice(7));if(secondCalls===1)return route.fulfill({status:503,json:{error:{message:"Temporary download failure"}}});}
      const b={id:crypto.randomUUID(),shipment_reference:data.shipment_reference,source_kind:"gmail",created_at:"2026-01-01T00:00:00Z"};packets.push(b);return route.fulfill({status:201,json:b});
    }
    return route.fulfill({status:404,json:{error:{code:"NOT_FOUND",message:"Fixture has no source preview."}}});
  });
  await page.goto(`/workflows/${wid}/engineer`);
  await page.getByRole("button",{name:"Agent",exact:true}).click();
  await page.getByRole("button",{name:"Run workflow",exact:true}).click();
  await page.getByRole("button",{name:"Saved input",exact:true}).click();
  await page.getByText("Capture from Gmail",{exact:true}).click();
  await page.getByRole("button",{name:"Search emails",exact:true}).click();
  await page.getByRole("button",{name:"Select all results",exact:true}).click();
  await expect(page.getByText("14 selected",{exact:true})).toBeVisible();
  await expect(page.getByRole("checkbox",{checked:true})).toHaveCount(14);
  await page.getByRole("button",{name:"Prepare shipment packets",exact:true}).click();
  await page.getByRole("button",{name:"Capture 2 suggested packets",exact:true}).click();
  await expect(page.getByText(/Capture stopped/)).toBeVisible();
  await page.getByRole("button",{name:"Capture 1 suggested packet",exact:true}).click();
  await expect(page.getByText("Packets saved. Choose one under Captured input, then start its run.")).toBeVisible();
  expect(firstCalls).toBe(1);expect(secondCalls).toBe(2);
  await page.getByRole("button",{name:"Clear selection",exact:true}).click();
  await expect(page.getByRole("region",{name:"Suggested shipment packets"})).toHaveCount(0);
  await expect(page.getByLabel("Captured input").locator("option")).toHaveCount(3);
});
