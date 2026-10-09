import { describe, it, expect } from "vitest";
import { validateGmailGrouping, type GmailGrouping } from "../src/domain/gmail-grouping";
import type { GmailMessage } from "../src/domain/gmail";
const messages: GmailMessage[] = [
  {id:"0000000000000001",thread_id:"a",subject:"Packet A",sender:"a@example.test",received_at:"",text:"Container ABCD1234567",attachments:[]},
  {id:"0000000000000002",thread_id:"b",subject:"Packet B",sender:"b@example.test",received_at:"",text:"MAWB 123-45678901",attachments:[]},
  {id:"0000000000000003",thread_id:"c",subject:"Unclear certificate",sender:"c@example.test",received_at:"",text:"Please find attached",attachments:[]},
];
function proposal(): GmailGrouping {
  return { groups: messages.slice(0,2).map((m,i)=>({reference:i?"123-45678901":"ABCD1234567",message_ids:[m.id],evidence:{message_id:m.id,quote:m.text},reason:"Reference appears in the body."})),unresolved:[{message_id:messages[2].id,reason:"No supported association."}] };
}
describe("email packet suggestions",()=>{
  it("keeps separate references and accounts for unresolved messages",()=>{
    expect(validateGmailGrouping(proposal(),messages)).toEqual(proposal());
  });
  it("rejects dropped and multiply assigned emails",()=>{
    const missing=proposal();missing.unresolved=[];
    expect(()=>validateGmailGrouping(missing,messages)).toThrow();
    const duplicate=proposal();duplicate.groups[0].message_ids.push(messages[1].id);
    expect(()=>validateGmailGrouping(duplicate,messages)).toThrow();
  });
  it("rejects invented references, fabricated quotes, and sources outside their packet",()=>{
    const invented=proposal();invented.groups[0].reference="ABCD0000000";
    expect(()=>validateGmailGrouping(invented,messages)).toThrow();
    const quote=proposal();quote.groups[0].evidence.quote="Container ABCD1234567 confirmed";
    expect(()=>validateGmailGrouping(quote,messages)).toThrow();
    const external=proposal();external.groups[0].evidence.message_id=messages[1].id;
    expect(()=>validateGmailGrouping(external,messages)).toThrow();
  });
  it("rejects unselected emails and duplicate reference groups",()=>{
    const unknown=proposal();unknown.unresolved.push({message_id:"not-selected",reason:"Missing"});
    expect(()=>validateGmailGrouping(unknown,messages)).toThrow();
    const duplicate=proposal();duplicate.groups.push({...duplicate.groups[0]});
    expect(()=>validateGmailGrouping(duplicate,messages)).toThrow();
  });
});
