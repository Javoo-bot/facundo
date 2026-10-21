import { PHASES, CROSS_CUTTING } from "../../dashboard/lib/lifecycle.ts";
import { writeFileSync } from "node:fs";
const b = (x:any)=>({id:x.id,trigger:x.trigger,handling:x.handling,status:x.status,milestone:x.milestone});
const data = {
  phases: PHASES.map(p=>({id:p.id,label:p.label,blurb:p.blurb,stages:p.stages.map(s=>({id:s.id,label:s.label,short:s.short,kind:s.kind,status:s.status,surface:s.surface??"",description:s.description,code:s.code??[],branches:(s.branches??[]).map(b)}))})),
  cross: CROSS_CUTTING.map(b),
};
writeFileSync(new URL("./lifecycle.json", import.meta.url), JSON.stringify(data));
const all=[...data.phases.flatMap(p=>p.stages.flatMap(s=>s.branches)),...data.cross];
const c:any={}; for(const x of all) c[x.status]=(c[x.status]||0)+1;
console.log(data.phases.map(p=>p.stages.length), data.cross.length, c, JSON.stringify(data).length);
