import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";
const OUT=process.env.REPORT_DIR||"reports", BASE="https://delphi-api.gensyn.ai/v1", FEED="https://competition.delphi.fyi/markets.json";
type Market={address:string;status:string;question:string};
type Receipt={receipts?:{submission?:{id?:string;status?:string};candidateId?:string;mode?:string}[]};
async function main(){
 const key=process.env.DELPHI_API_ACCESS_KEY;if(!key)throw new Error("DELPHI_API_ACCESS_KEY missing");
 const client=new EvidenceClient({baseUrl:BASE,apiKey:key,agentId:"sentinel-prime",agentHarness:"Bilalsnz/Sentinel-",agentModel:"sentinel-prime-outcome-tracker"});
 const terms=await client.getTerms();if(!terms.data.acceptedAt)throw new Error("Delphi terms not accepted; outcome polling paused.");
 const feed=await fetch(FEED,{signal:AbortSignal.timeout(20000)});if(!feed.ok)throw new Error("markets feed HTTP "+feed.status);
 const body=await feed.json() as {markets?:Market[]}|Market[];const markets=Array.isArray(body)?body:(body.markets??[]);
 const ids=new Map<string,{market:string;question:string}>();
 for(const market of markets){
  if(market.status!=="open"&&market.status!=="closed"&&market.status!=="resolved")continue;
  try{
   const list=await client.listSubmissions({market:market.address,agentId:"sentinel-prime",limit:50});
   for(const item of list.data.items)ids.set(item.id,{market:market.address,question:market.question});
  }catch(e){console.warn("Could not list submissions for "+market.address+": "+(e instanceof Error?e.message:"unknown"));}
 }
 const rows:unknown[]=[];
 for(const [id,meta] of ids){
  try{
   const response=await client.getSubmission(id);
   rows.push({id,marketAddress:meta.market,marketQuestion:meta.question,submission:response.data,requestId:response.meta.requestId??null,checkedAt:new Date().toISOString()});
  }catch(e){rows.push({id,marketAddress:meta.market,marketQuestion:meta.question,error:e instanceof Error?e.message:"unknown",checkedAt:new Date().toISOString()});}
  await new Promise(r=>setTimeout(r,250));
 }
 await mkdir(OUT,{recursive:true});
 const report={agent:"sentinel-prime",mode:"judgment-and-settlement-tracking",generatedAt:new Date().toISOString(),termsVersion:terms.data.version,submissionsTracked:rows.length,submissions:rows,safety:{readOnly:true,noNewSubmissions:true,rawDelphiStatusesPreserved:true}};
 await writeFile(join(OUT,"outcome-tracking.json"),JSON.stringify(report,null,2)+"\n");
 const md=["# Sentinel Prime — Judgment & Settlement Tracking","","- Checked: "+report.generatedAt,"- Submissions tracked: "+rows.length,"> Read-only polling. Raw Delphi response is preserved; no inference is made about pending or unreported rewards.",""];
 for(const row of rows as {id:string;submission?:{status?:string;verdict?:string;bounty?:unknown;settlement?:unknown};error?:string;marketQuestion?:string}[]){
  md.push("## "+row.id,"","- Market: "+(row.marketQuestion??"unknown"),"- Status: "+(row.submission?.status??"unavailable"),"- Verdict: "+(row.submission?.verdict??"not reported"),"- Bounty: "+(row.submission?.bounty===undefined?"not reported":JSON.stringify(row.submission.bounty)),"- Error: "+(row.error??"none"),"");
 }
 await writeFile(join(OUT,"outcome-tracking.md"),md.join("\n")+"\n");
 console.log("Outcome tracker checked "+rows.length+" submissions.");
}
main().catch(e=>{console.error("Outcome tracking failed:",e instanceof Error?e.message:"unknown");process.exit(1);});
