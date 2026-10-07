import {EngineerClient} from "@/components/engineering/engineer-client";
export default async function EngineerPage({params}:{params:Promise<{id:string}>}) {return <EngineerClient id={(await params).id}/>;}
