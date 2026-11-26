import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";

type Market={address:string;question:string;status:string;evidenceCutoffAt:string;resolutionCriteria?:string;delphiUrl?:string};
type Snapshot={marketAddress:string;url:string;status:string;sha256:string|null;publishedAt:string|null;file:string|null;reason:string|null};
type Candidate={
 id:string;marketAddress:string;claim:string;sourceUrl:string;snapshotFile:string;quote:string;
 publishedAt:string;resolutionMapping:string;humanVerified:boolean;verificationNote:string;
};
type Gate={name:string;passed:boolean;detail:string};
const BASE="https://delphi.fyi/v1",FEED="https://competition.delphi.fyi/markets.json";
const OUT=process.env.REPORT_DIR||"reports",INPUT=process.env.CANDIDATES_FILE||"candidate-staging.json";
function parseMarkets(v:unknown):Market[]{const xs=Array.isArray(v)?v:(v&&typeof v==="object"&&Array.isArray((v as {markets?:unknown[]}).markets)?(v as {markets:unknown[]}).markets:[]);return xs as Market[];}
function floor(criteria?:string):string|null{if(!criteria)return null;return criteria.match(/(?:published|confirmed|completed) strictly after (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/i)?.[1]??null;}
function clean(s:string):string{return s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/\s+/g," ").trim().toLowerCase();}
async function sha(path:string):Promise<string>{return createHash("sha256").update(await readFile(path)).digest("hex");}
async function main(){
 const key=process.env.DELPHI_API_ACCESS_KEY;if(!key)throw new Error("DELPHI_API_ACCESS_KEY missing");
 const snapPath=join(OUT,"source-snapshots.json");if(!existsSync(snapPath))throw new Error("Missing reports/source-snapshots.json; run source snapshot workflow first.");
 const snapshotReport=JSON.parse(await readFile(snapPath,"utf8")) as {sources:Snapshot[]};
 const candidates=JSON.parse(await readFile(INPUT,"utf8")) as Candidate[];
 if(!Array.isArray(candidates))throw new Error("candidate-staging.json must contain an array.");
 const client=new EvidenceClient({baseUrl:BASE,apiKey:key,agentId:"sentinel-prime",agentHarness:"Bilalsnz/Sentinel-",agentModel:"sentinel-prime-candidate-validator"});
 const [terms,limits,feed]=await Promise.all([client.getTerms(),client.getLimits(),fetch(FEED,{signal:AbortSignal.timeout(20000)})]);
 if(!feed.ok)throw new Error("markets.json HTTP "+feed.status);
 const markets=parseMarkets(await feed.json()),marketMap=new Map(markets.map(m=>[m.address.toLowerCase(),m]));
 const entryCache=new Map<string,{canSubmit:boolean;reason:string|null;remaining:number|null}>();
 const seen=new Set<string>(),results=[];
 for(const c of candidates){
  const gates:Gate[]=[];
  const m=marketMap.get(c.marketAddress?.toLowerCase());
  const snap=snapshotReport.sources.find(s=>s.marketAddress.toLowerCase()===c.marketAddress?.toLowerCase()&&s.url===c.sourceUrl&&s.status==="fetched"&&Boolean(s.file&&s.sha256));
  const add=(name:string,passed:boolean,detail:string)=>gates.push({name,passed,detail});
  add("market_exists",Boolean(m),m?.question??"Market address not found in current official feed.");
  add("market_open",Boolean(m&&m.status==="open"),m?.status??"No market.");
  add("cutoff_future",Boolean(m&&Date.parse(m.evidenceCutoffAt)>Date.now()),m?.evidenceCutoffAt??"No cutoff.");
  const nf=floor(m?.resolutionCriteria);
  add("novelty_boundary_present",Boolean(nf),nf??"No machine-readable strict novelty boundary; block.");
  const published=Date.parse(c.publishedAt);
  add("publication_date_valid",Boolean(c.publishedAt&&Number.isFinite(published)),c.publishedAt||"Missing publication timestamp.");
  add("strictly_new",Boolean(nf&&Number.isFinite(published)&&published>Date.parse(nf)),nf?("Published "+(c.publishedAt||"unknown")+"; must be strictly after "+nf):"Cannot compare without novelty boundary.");
  add("snapshot_fetched",Boolean(snap&&snap.status==="fetched"&&snap.sha256&&snap.file),snap?.status??"No exact matching archived snapshot.");
  let body="",hashOk=false,quoteOk=false;
  if(snap?.file&&snap.sha256){const p=resolve(OUT,snap.file);if(!p.startsWith(resolve(OUT)+"/"))throw new Error("Snapshot path escaped report directory.");if(existsSync(p)){hashOk=await sha(p)===snap.sha256;body=clean(await readFile(p,"utf8"));}}
  add("snapshot_hash_matches",hashOk,hashOk?"SHA-256 matches archived metadata.":"Missing file or hash mismatch.");
  add("publication_matches_snapshot",Boolean(snap?.publishedAt&&c.publishedAt===snap.publishedAt),snap?.publishedAt??"Snapshot extractor found no publication date.");
  quoteOk=Boolean(c.quote&&body.includes(clean(c.quote)));
  add("quote_verbatim_in_snapshot",quoteOk,quoteOk?"Quoted passage found in archived source text.":"Quote not found exactly after basic HTML normalization.");
  add("human_source_review",c.humanVerified===true&&Boolean(c.verificationNote?.trim()),c.humanVerified?"Human verification marked; note: "+(c.verificationNote||"missing"):"Human verification not marked.");
  add("claim_present",Boolean(c.claim?.trim()&&c.claim.length<=8000),c.claim?.length>8000?"Claim exceeds 8,000 characters.":"Claim missing or empty.");
  add("resolution_mapping_present",Boolean(c.resolutionMapping?.trim()),"Must explain direct link to exact resolver, metric, threshold and unit.");
  const fingerprint=(c.marketAddress+"|"+clean(c.quote)).slice(0,12000);
  const duplicate=seen.has(fingerprint);seen.add(fingerprint);
  add("not_duplicate",!duplicate,duplicate?"Duplicate quote already staged for this market.":"No duplicate in this staging batch.");
  const entry=entryCache.get(c.marketAddress.toLowerCase())??await (async()=>{const r=await client.getEntryState(c.marketAddress);const x={canSubmit:Boolean(r.data.canSubmit),reason:r.data.reason??null,remaining:r.data.remainingOnMarket??null};entryCache.set(c.marketAddress.toLowerCase(),x);return x;})();
  add("delphi_entry_eligible",entry.canSubmit,entry.reason??("Remaining slots: "+entry.remaining));
  add("terms_accepted",Boolean(terms.data.acceptedAt),terms.data.acceptedAt??"Current terms are not accepted.");
  const passed=gates.every(g=>g.passed);
  results.push({id:c.id,marketAddress:c.marketAddress,market:m?.question??null,claim:c.claim,sourceUrl:c.sourceUrl,snapshotFile:snap?.file??c.snapshotFile,publishedAt:c.publishedAt,noveltyFloor:nf,passed,gates});
 }
 const report={agent:"sentinel-prime",mode:"candidate-validation-only",generatedAt:new Date().toISOString(),terms:{version:terms.data.version,acceptedAt:terms.data.acceptedAt},limits:limits.data,totalCandidates:candidates.length,passed:results.filter(r=>r.passed).length,blocked:results.filter(r=>!r.passed).length,candidates:results,safety:{evidenceSubmitted:false,termsChanged:false,submissionCodeNotInvoked:true,passingMeansEligibleForHumanReviewOnly:true}};
 await mkdir(OUT,{recursive:true});await writeFile(join(OUT,"candidate-validation.json"),JSON.stringify(report,null,2)+"\n");
 const lines=["# Sentinel Prime — Candidate Validation","", "- Generated: "+report.generatedAt,"- Candidates: "+candidates.length,"- Passed gates: "+report.passed,"- Blocked: "+report.blocked,"- Terms accepted: "+Boolean(terms.data.acceptedAt),"- Submissions left this UTC hour: "+limits.data.submitsLeftThisHour,"> Passing means eligible for human review only. This tool never submits evidence.",""];
 for(const r of results){lines.push("## "+r.id+" — "+(r.passed?"PASS":"BLOCKED"),"",r.market??r.marketAddress,"",r.claim||"(claim missing)","","- Source: "+r.sourceUrl,"- Published: "+r.publishedAt,"- Novelty floor: "+r.noveltyFloor,"");for(const g of r.gates)lines.push("- ["+(g.passed?"PASS":"BLOCK")+"] "+g.name+": "+g.detail);lines.push("");}
 lines.push("## Safety","- No evidence submitted.","- No API submit method called.","- Every passing candidate still requires a separate explicit human decision.");
 await writeFile(join(OUT,"candidate-validation.md"),lines.join("\n")+"\n");
 console.log("Candidates: "+candidates.length+"; passed: "+report.passed+"; blocked: "+report.blocked);
 console.log("No evidence submitted; submission endpoint was not invoked.");
}
main().catch(e=>{console.error("Candidate validation failed:",e instanceof Error?e.message:"Unknown error");process.exit(1);});
