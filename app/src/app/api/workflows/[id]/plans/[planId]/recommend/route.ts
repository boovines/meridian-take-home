import {body,parseId,respond} from "@/server/http";
import {getDatabase} from "@/server/database";
import {approvePlanInput} from "@/domain/engineering";
import {suggestPlanMethods} from "@/server/engineering/recommendation-service";
export const maxDuration=120;
export async function POST(request:Request,{params}:{params:Promise<{id:string;planId:string}>}) {
return respond(async()=>{const p=await params,data=await body(request,approvePlanInput);return suggestPlanMethods(await getDatabase(),parseId(p.id),parseId(p.planId),data.expected_revision,AbortSignal.any([request.signal,AbortSignal.timeout(90000)]));});
}
