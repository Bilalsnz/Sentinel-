import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";

type Market={address:string;question:string;status:string;evidenceCutoffAt:string;resolutionCriteria?:string;dataSources?:string[];delphiUrl?:string};
type Snap={marketAddress:string;url:string;status:string;sha256:string|null;publishedAt:string|null;file:string|null;reason:string|null};
type Candidate={id:string;marketAddress:string;claim:string;sourceUrl:string;snapshotFile:string;quote:string;publishedAt:string;resolutionMapping:string;humanVerified:boolean;verificationNote:string;corroboratingUrls:string[]};
type Fact={market:Market;snapshot:Snap;domain:string;sentence:string;tokens:Set<string>;numbers:Set<string>;score:number};
const OUT=process.env.REPORT_DIR||"reports", FEED="https://competition.delphi.fyi/markets.json", BASE="https://delphi.fyi/v1";
const STOP=new Set("about after again against also among another any are because been before being between both could does during each from further have into just more most other over same should some such than that their there these they this those through under until very what when where which while with would".split(" "));
function parseMarkets(v:unknown):Market[]{const xs=Array.isArray(v)?v:(v&&typeof v==="object"&&Array.isArray((v as {markets?:unknown[]}).markets)?(v as {markets:unknown[]}).markets:[]);return xs as Market[];}
function floor(s?:string):number|null{if(!s)return null;const m=s.match(/(?:published|confirmed|completed) strictly after (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/i);if(!m)return null;const n=Date.parse(m[1]);return Number.isFinite(n)?n:null;}
function textOf(s:string):string{return s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ").replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/article|\/section)\b[^>]*>/gi,"\n").replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/[ \t\r]+/g," ").replace(/\n\s+/g,"\n").replace(/\n{2,}/g,"\n").trim();}
function words(s:string):Set<string>{return new Set((s.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g)||[]).filter(x=>!STOP.has(x)));}
function nums(s:string):Set<string>{return new Set((s.match(/(?:\$\s*)?\b\d[\d,]*(?:\.\d+)?\s*(?:%|percent|million|billion|thousand|basis points|bps)?/gi)||[]).map(x=>x.toLowerCase().replace(/\$/g,"").replace(/,/g,"").replace(/\s+/g,"").replace(/percent$/,"%").replace(/basispoints$|bps$/,"bps")));}
function similarity(a:Set<string>,b:Set<string>):number{const intersection=[...a].filter(x=>b.has(x)).length;return intersection/Math.max(1,new Set([...a,...b]).size);}
function sentences(s:string):string[]{return s.split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9“"'])/).map(x=>x.replace(/\s+/g," ").trim()).filter(x=>x.length>=45&&x.length<=650&&/[0-9]/.test(x));}
function primaryDomain(url:string):string{const h=new URL(url).hostname.toLowerCase().replace(/^www\./,"");return h.split(".").slice(-2).join(".");}
async function main(){
 const key=process.env.DELPHI_API_ACCESS_KEY;if(!key)throw new Error("DELPHI_API_ACCESS_KEY missing");
 const [feed,snapshotRaw]=await Promise.all([fetch(FEED,{signal:AbortSignal.timeout(20000)}),readFile(join(OUT,"source-snapshots.json"),"utf8")]);
 if(!feed.ok)throw new Error("markets feed HTTP "+feed.status);
 const markets=parseMarkets(await feed.json()), snaps=(JSON.parse(snapshotRaw) as {sources:Snap[]}).sources;
 const byMarket=new Map(markets.map(m=>[m.address.toLowerCase(),m]));
 const client=new EvidenceClient({baseUrl:BASE,apiKey:key,agentId:"sentinel-prime",agentHarness:"Bilalsnz/Sentinel-",agentModel:"sentinel-prime-evidence-discovery"});
 const terms=await client.getTerms();if(!terms.data.acceptedAt)throw new Error("Delphi terms not accepted; discovery is paused.");
 const entryCache=new Map<string,boolean>();
 const facts:Fact[]=[];
 const blocked:{market:string;url:string;reason:string}[]=[];
 for(const snap of snaps){
  if(snap.status!=="fetched"||!snap.file||!snap.sha256||!snap.publishedAt) {blocked.push({market:snap.marketAddress,url:snap.url,reason:"No successful snapshot or verifiable publication timestamp"});continue;}
  const market=byMarket.get(snap.marketAddress.toLowerCase());if(!market||market.status!=="open"){blocked.push({market:snap.marketAddress,url:snap.url,reason:"Market missing or closed"});continue;}
  const novelty=floor(market.resolutionCriteria),published=Date.parse(snap.publishedAt),cutoff=Date.parse(market.evidenceCutoffAt);
  if(novelty===null||!Number.isFinite(published)||published<=novelty||published>=cutoff){blocked.push({market:snap.marketAddress,url:snap.url,reason:"Publication time fails strict novelty/cutoff gate"});continue;}
  let eligible=entryCache.get(market.address.toLowerCase());
  if(eligible===undefined){const e=await client.getEntryState(market.address);eligible=Boolean(e.data.canSubmit);entryCache.set(market.address.toLowerCase(),eligible);}
  if(!eligible){blocked.push({market:snap.marketAddress,url:snap.url,reason:"Delphi entry state does not permit submission"});continue;}
  const path=resolve(OUT,snap.file);if(!path.startsWith(resolve(OUT)+"/")){blocked.push({market:snap.marketAddress,url:snap.url,reason:"Snapshot path escaped report directory"});continue;}
  const body=await readFile(path);const hash=createHash("sha256").update(body).digest("hex");if(hash!==snap.sha256){blocked.push({market:snap.marketAddress,url:snap.url,reason:"Snapshot hash mismatch"});continue;}
  const raw=textOf(body.toString("utf8"));const domain=primaryDomain(snap.url);
  const marketTokens=words(market.question+" "+(market.resolutionCriteria||""));
  for(const sentence of sentences(raw)){
   const tokens=words(sentence),score=similarity(tokens,marketTokens),numbers=nums(sentence);
   if(score<0.18||numbers.size===0)continue;
   facts.push({market,snapshot:snap,domain,sentence,tokens,numbers,score});
  }
 }
 const candidates:Candidate[]=[],conflicts:{market:string;factA:string;factB:string;reason:string}[]=[];
 const used=new Set<string>();
 for(const fact of facts.sort((a,b)=>b.score-a.score)){
  const peers=facts.filter(x=>x!==fact&&x.market.address.toLowerCase()===fact.market.address.toLowerCase()&&x.domain!==fact.domain&&similarity(x.tokens,fact.tokens)>=0.55);
  const corroborating=peers.filter(x=>[...fact.numbers].some(n=>x.numbers.has(n)));
  const contradictory=peers.filter(x=>[...fact.numbers].some(n=>![...x.numbers].includes(n))&&[...x.numbers].some(n=>![...fact.numbers].includes(n)));
  if(contradictory.length){conflicts.push({market:fact.market.question,factA:fact.sentence,factB:contradictory[0].sentence,reason:"Independent sources share substantial topic language but report different numeric values; blocked for manual adjudication."});continue;}
  if(corroborating.length===0)continue;
  const fingerprint=fact.market.address.toLowerCase()+"|"+fact.snapshot.url+"|"+fact.sentence.toLowerCase();
  if(used.has(fingerprint))continue;used.add(fingerprint);
  const id="AUTO-"+createHash("sha256").update(fingerprint).digest("hex").slice(0,20).toUpperCase();
  candidates.push({
   id,marketAddress:fact.market.address,
   claim:"Source reports: "+fact.sentence+" This fact is corroborated by at least one independent domain reporting the same numeric detail; it is presented as reported context, not as an inference about the market outcome.",
   sourceUrl:fact.snapshot.url,snapshotFile:fact.snapshot.file!,quote:fact.sentence,corroboratingUrls:[...new Set(corroborating.map(x=>x.snapshot.url).filter(u=>u!==fact.snapshot.url))],
   publishedAt:fact.snapshot.publishedAt!,
   resolutionMapping:"The market asks: "+fact.market.question+". The cited fact overlaps the market's stated subject and reports a directly observable numeric detail. It is corroborated by an independent source with the same numeric detail. It does not by itself establish the final resolution unless the resolver's exact metric, scope, unit and time window match; treat it as contextual evidence where they do not.",
   humanVerified:false,verificationNote:"Automatically extracted from a hash-verified public source snapshot; corroborated by an independent domain. No model-generated claim is represented as source text."
  });
 }
 const unique=candidates.filter((c,i)=>candidates.findIndex(x=>x.marketAddress.toLowerCase()===c.marketAddress.toLowerCase()&&x.sourceUrl===c.sourceUrl&&x.quote===c.quote)===i);
 await mkdir(OUT,{recursive:true});
 await writeFile("candidate-staging.auto.json",JSON.stringify(unique,null,2)+"\n");
 const report={agent:"sentinel-prime",mode:"automated-evidence-discovery",generatedAt:new Date().toISOString(),marketsScanned:markets.length,snapshotsReviewed:snaps.length,extractableFacts:facts.length,corroboratedCandidates:unique.length,blocked:blocked.length,conflicts:conflicts.length,candidates:unique.map(c=>({id:c.id,marketAddress:c.marketAddress,sourceUrl:c.sourceUrl,publishedAt:c.publishedAt,claim:c.claim,quote:c.quote,corroboratingUrls:c.corroboratingUrls})),blockedSources:blocked,conflictDetails:conflicts,safety:{requiresStrictNovelty:true,requiresTwoIndependentDomains:true,contradictionsBlocked:true,sourceTextPreservedVerbatim:true,noUnsupportedPrediction:true}};
 await writeFile(join(OUT,"discovery-report.json"),JSON.stringify(report,null,2)+"\n");
 const md=["# Sentinel Prime — Automated Evidence Discovery","","- Generated: "+report.generatedAt,"- Markets scanned: "+markets.length,"- Snapshots reviewed: "+snaps.length,"- Numeric facts extracted: "+facts.length,"- Corroborated candidates staged: "+unique.length,"- Blocked sources: "+blocked.length,"- Contradictions requiring review: "+conflicts.length,"","Candidates require a separate strict validator pass before any Delphi submission.",""];
 for(const c of unique)md.push("## "+c.id,"","- Market: "+c.marketAddress,"- Source: "+c.sourceUrl,"- Published: "+c.publishedAt,"- Claim: "+c.claim,"- Exact quote: "+c.quote,"");
 if(!unique.length)md.push("No candidate met the two-independent-domain corroboration and strict novelty gates. This is a valid safe outcome.");
 await writeFile(join(OUT,"discovery-report.md"),md.join("\n")+"\n");
 console.log("Discovery complete: "+facts.length+" facts, "+unique.length+" corroborated candidates, "+conflicts.length+" conflicts.");
}
main().catch(e=>{console.error("Evidence discovery failed:",e instanceof Error?e.message:"Unknown error");process.exit(1);});
