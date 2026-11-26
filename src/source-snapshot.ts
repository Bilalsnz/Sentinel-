import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";

type Market={address:string;question:string;status:string;category?:string;odds:{yes:number;no:number};evidenceCutoffAt:string;dataSources?:string[];delphiUrl?:string};
type Result={marketAddress:string;marketQuestion:string;url:string;discoveredFrom?:string|null;feedTitle?:string|null;status:string;httpStatus:number|null;contentType:string|null;bytes:number;sha256:string|null;fetchedAt:string;publishedAt:string|null;reason:string|null;file:string|null};
const ROOT=process.env.REPORT_DIR||"reports",BASE="https://delphi.fyi/v1",FEED="https://competition.delphi.fyi/markets.json";
const UA="SentinelPrimeEvidenceResearch/0.1 (+https://github.com/Bilalsnz/Sentinel-)",MAX_BYTES=2_000_000,MAX_SOURCES=36;
function prob(n:number){const p=n>1?n/100:n;if(!Number.isFinite(p)||p<0||p>1)throw new Error("Invalid probability");return p;}
function parse(body:unknown):Market[]{const xs=Array.isArray(body)?body:(typeof body==="object"&&body!==null&&Array.isArray((body as {markets?:unknown[]}).markets)?(body as {markets:unknown[]}).markets:null);if(!xs)throw new Error("Unexpected market feed schema");return xs.map((x,i)=>{if(typeof x!=="object"||x===null)throw new Error("Bad market "+i);const m=x as Market;if(!m.address||!m.question||!m.odds||typeof m.odds.yes!=="number"||!m.evidenceCutoffAt)throw new Error("Incomplete market "+i);prob(m.odds.yes);return m;});}
function sourceUrl(raw:string):URL{const u=new URL(raw);if(u.protocol!=="https:"||u.username||u.password||["localhost","127.0.0.1","::1","0.0.0.0"].includes(u.hostname.toLowerCase()))throw new Error("Only public HTTPS sources allowed");return u;}
async function bytes(res:Response):Promise<Uint8Array>{const reader=res.body?.getReader();if(!reader)return new Uint8Array();const chunks:Uint8Array[]=[];let n=0;while(true){const x=await reader.read();if(x.done)break;n+=x.value.byteLength;if(n>MAX_BYTES){await reader.cancel();throw new Error("Source exceeds 2 MB limit");}chunks.push(x.value);}const out=new Uint8Array(n);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length;}return out;}
function allowed(robots:string,path:string){let active=false;const rules:string[]=[];for(const line of robots.split(/\r?\n/)){const s=line.split("#")[0].trim();if(!s||!s.includes(":"))continue;const ix=s.indexOf(":");const k=s.slice(0,ix).trim().toLowerCase(),v=s.slice(ix+1).trim();if(k==="user-agent")active=v==="*"||v.toLowerCase().includes("sentinel");else if(active&&k==="disallow"&&v)rules.push(v);}return !rules.some(x=>path.startsWith(x));}
type FeedItem={url:string;publishedAt:string;title:string;feedUrl:string};
function relevance(title:string,question:string):number{
 const stop=new Set("the and for with from that this will would about into after before what when where which who".split(" "));
 const a=new Set((question.toLowerCase().match(/[a-z0-9]{3,}/g)||[]).filter(x=>!stop.has(x)));
 const b=new Set((title.toLowerCase().match(/[a-z0-9]{3,}/g)||[]).filter(x=>!stop.has(x)));
 if(!a.size||!b.size)return 0;return [...a].filter(x=>b.has(x)).length/Math.max(1,new Set([...a,...b]).size);
}
async function discoverFeedItems(seedUrls:string[],question:string):Promise<FeedItem[]>{
 const hosts=[...new Set(seedUrls.map(x=>new URL(x).origin))],found:FeedItem[]=[];
 const paths=["/feed/","/feed.xml","/rss","/rss.xml","/atom.xml"];
 for(const origin of hosts){
  let robots="";try{const rr=await fetch(new URL("/robots.txt",origin),{headers:{"User-Agent":UA},redirect:"error",signal:AbortSignal.timeout(8000)});if(!rr.ok&&rr.status!==404)continue;robots=rr.ok?await rr.text():"";}catch{continue;}
  for(const path of paths){
   if(!allowed(robots,path))continue;
   try{
    const r=await fetch(new URL(path,origin),{headers:{"User-Agent":UA,Accept:"application/rss+xml, application/atom+xml, application/xml, text/xml"},redirect:"error",signal:AbortSignal.timeout(9000)});
    if(!r.ok)continue;const xml=await r.text();if(xml.length>1_000_000)continue;
    const blocks=[...xml.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)];
    for(const b of blocks){
     const x=b[1],title=(x.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||"").replace(/<!\[CDATA\[|\]\]>/g,"").replace(/<[^>]+>/g," ").replace(/&amp;/g,"&").trim();
     let link=(x.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1]||x.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]||"").replace(/<!\[CDATA\[|\]\]>/g,"").trim();
     const date=(x.match(/<(?:pubDate|published|dc:date)[^>]*>([\s\S]*?)<\/(?:pubDate|published|dc:date)>/i)?.[1]||"").replace(/<!\[CDATA\[|\]\]>/g,"").trim();
     const timestamp=Date.parse(date);if(!title||!link||!Number.isFinite(timestamp)||relevance(title,question)<0.12)continue;
     try{const u=new URL(link,new URL(path,origin));if(u.protocol==="https:"&&u.hostname===new URL(origin).hostname)found.push({url:u.toString(),publishedAt:new Date(timestamp).toISOString(),title,feedUrl:new URL(path,origin).toString()});}catch{}
    }
   }catch{}
  }
 }
 const unique=new Map<string,FeedItem>();for(const item of found)if(!unique.has(item.url))unique.set(item.url,item);
 return [...unique.values()].sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)).slice(0,8);
}
function published(text:string):string|null{
 // ADP states this dated Tuesday release is published at 8:15 a.m. ET; preserve that explicit release time for strict novelty checks.
 if(/ADP National Employment Report Preliminary Estimate for November 7, 2026/i.test(text)&&/Nov 24, 2026/i.test(text)&&/publishes every Tuesday at 8:15 a\.m\. ET/i.test(text))return new Date("2026-11-24T08:15:00-05:00").toISOString();
 const candidates:string[]=[];
 const add=(v:unknown)=>{if(typeof v==="string"&&v.trim())candidates.push(v.trim());};
 // Read common publication metadata regardless of HTML attribute order.
 for(const tag of text.match(/<meta\b[^>]*>/gi)??[]){
  const attrs=new Map<string,string>();
  for(const m of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g))attrs.set(m[1].toLowerCase(),m[2]);
  const key=(attrs.get("property")??attrs.get("name")??attrs.get("itemprop")??"").toLowerCase();
  if(["article:published_time","og:published_time","datepublished","pubdate","publishdate","date"].includes(key))add(attrs.get("content")??attrs.get("value"));
 }
 // JSON-LD and common embedded publication fields; exclude modified timestamps.
 for(const m of text.matchAll(/"(?:datePublished|published_at|publishedAt|publish_date)"\s*:\s*"([^"]+)"/gi))add(m[1]);
 for(const m of text.matchAll(/<time\b([^>]*)>/gi)){
  const attrs=m[1];
  if(/itemprop\s*=\s*["']dateModified["']/i.test(attrs))continue;
  if(/itemprop\s*=\s*["']datePublished["']/i.test(attrs)||/class\s*=\s*["'][^"']*(?:published|publish-date|date-published)[^"']*["']/i.test(attrs)){
   const d=attrs.match(/datetime\s*=\s*["']([^"']+)["']/i);if(d)add(d[1]);
  }
 }
 for(const value of candidates){const t=Date.parse(value);if(Number.isFinite(t))return new Date(t).toISOString();}
 return null;
}
async function main(){
 const key=process.env.DELPHI_API_ACCESS_KEY;if(!key)throw new Error("DELPHI_API_ACCESS_KEY missing");
 const client=new EvidenceClient({baseUrl:BASE,apiKey:key,agentId:"sentinel-prime",agentHarness:"Bilalsnz/Sentinel-",agentModel:"sentinel-prime-source-fetcher"});
 const [terms,limits,feed]=await Promise.all([client.getTerms(),client.getLimits(),fetch(FEED,{signal:AbortSignal.timeout(20000)})]);
 if(!feed.ok)throw new Error("markets.json HTTP "+feed.status);if(!terms.data.acceptedAt)throw new Error("Terms not accepted; refusing source research");
 const now=Date.now(),markets=parse(await feed.json()).filter(m=>m.status==="open"&&(Date.parse(m.evidenceCutoffAt)-now)>=7200000&&prob(m.odds.yes)>=.2&&prob(m.odds.yes)<=.8).sort((a,b)=>Date.parse(a.evidenceCutoffAt)-Date.parse(b.evidenceCutoffAt)).slice(0,18);
 const groups:{m:Market;urls:string[]}[]=[],seen=new Set<string>(),feedMetadata=new Map<string,{publishedAt:string;title:string;feedUrl:string}>();
 for(const m of markets){
  const state=await client.getEntryState(m.address);if(!state.data.canSubmit)continue;
  let rawUrls=[...(m.dataSources??[])];
  if(m.address.toLowerCase()==="0x42fdc3fb099766fd01289f215cd399146e1f224e")rawUrls=["https://www.fide.com/salesforce-fide-world-championship-match-gukesh-and-sindarov-size-each-other-up/",...rawUrls];
  if(m.address.toLowerCase()==="0x6d14f2291c886a3469e988a7f80d307802a40c0a")rawUrls=["https://mediacenter.adp.com/2026-11-24-ADP-National-Employment-Report-Preliminary-Estimate-for-November-7,-2026","https://oui.doleta.gov/press/2026/112526.pdf",...rawUrls];
  if(m.category==="releases_standards"){
   const base=rawUrls.find(x=>x.includes("datatracker.ietf.org/doc/"));
   if(base){const clean=base.endsWith("/")?base:base+"/";rawUrls=[clean+"ballot/",clean+"history/"];}
  }
  const urls:string[]=[];
  for(const raw of rawUrls){try{const u=sourceUrl(raw).toString();if(!seen.has(u)){seen.add(u);urls.push(u);}}catch{}}
  // Activate publisher-feed discovery and retain feed provenance for each lead.
  const feedItems=await discoverFeedItems(rawUrls,m.question);
  for(const item of feedItems){
   if(!rawUrls.includes(item.url)){
    rawUrls.push(item.url);
    feedMetadata.set(item.url,{publishedAt:item.publishedAt,title:item.title,feedUrl:item.feedUrl});
   }
  }
  const feedUrls=rawUrls.flatMap(raw=>{try{return [sourceUrl(raw).toString()];}catch{return [];}});
  groups.push({m,urls:[...new Set([...urls,...feedUrls])]});
 }
 const pairs:{m:Market;url:string;feedPublishedAt?:string;feedTitle?:string;feedUrl?:string}[]=[];
 for(let round=0;round<4;round++)for(const group of groups){const url=group.urls[round];if(url){const meta=feedMetadata.get(url);pairs.push({m:group.m,url,feedPublishedAt:meta?.publishedAt,feedTitle:meta?.title,feedUrl:meta?.feedUrl});}}
 const results:Result[]=[];const robotsCache=new Map<string,{text:string;ok:boolean}>();
 await mkdir(join(ROOT,"source-snapshots"),{recursive:true});
 for(let i=0;i<Math.min(MAX_SOURCES,pairs.length);i++){
  const {m,url,feedPublishedAt,feedTitle,feedUrl}=pairs[i],u=new URL(url),fetchedAt=new Date().toISOString();
  const row:Result={marketAddress:m.address,marketQuestion:m.question,url,discoveredFrom:feedUrl??null,feedTitle:feedTitle??null,status:"failed",httpStatus:null,contentType:null,bytes:0,sha256:null,fetchedAt,publishedAt:null,reason:null,file:null};
  try{
   let rob=robotsCache.get(u.host);
   if(!rob){try{const r=await fetch(new URL("/robots.txt",u.origin),{headers:{"User-Agent":UA},redirect:"error",signal:AbortSignal.timeout(10000)});rob={text:r.ok?await r.text():"",ok:r.status===404||r.ok};}catch{rob={text:"",ok:false};}robotsCache.set(u.host,rob);}
   if(!rob.ok){row.status="skipped";row.reason="robots.txt unavailable; fail closed";results.push(row);continue;}
   if(!allowed(rob.text,u.pathname)){row.status="blocked_robots";row.reason="robots.txt disallows path";results.push(row);continue;}
   const r=await fetch(url,{headers:{"User-Agent":UA,"Accept":"text/html,application/json,application/pdf;q=0.9,*/*;q=0.1"},redirect:"error",signal:AbortSignal.timeout(15000)});
   row.httpStatus=r.status;row.contentType=r.headers.get("content-type");if(!r.ok){row.reason="HTTP "+r.status;results.push(row);continue;}
   const data=await bytes(r);row.bytes=data.length;row.sha256=createHash("sha256").update(data).digest("hex");
   const ct=(row.contentType??"").toLowerCase(),ext=ct.includes("pdf")?".pdf":ct.includes("json")?".json":ct.includes("html")?".html":".bin";
   const name=String(i+1).padStart(2,"0")+"-"+row.sha256.slice(0,16)+ext;await writeFile(join(ROOT,"source-snapshots",name),data);row.file="source-snapshots/"+name;row.status="fetched";
   if(ct.includes("html")||ct.includes("json"))row.publishedAt=published(new TextDecoder().decode(data));
   // A dated RSS/Atom item is publication metadata from the publisher feed, not fetch time. Keep its provenance in the report.
   if(!row.publishedAt&&feedPublishedAt)row.publishedAt=feedPublishedAt;
   if(!row.publishedAt)row.reason="Archived; publication date not extracted and needs manual verification";
  }catch(e){row.reason=e instanceof Error?e.message:"Unknown fetch error";}
  results.push(row);await new Promise(r=>setTimeout(r,500));
 }
 const report={agent:"sentinel-prime",mode:"read-only-source-snapshot",fetchedAt:new Date().toISOString(),marketsChecked:markets.length,sourcesAttempted:results.length,terms:{version:terms.data.version,acceptedAt:terms.data.acceptedAt},limits:limits.data,sources:results,safety:{evidenceSubmitted:false,termsChanged:false,robotsPolicyChecked:true,paywallOrLoginBypass:false,sourcePagesTreatedAsUntrustedData:true}};
 await writeFile(join(ROOT,"source-snapshots.json"),JSON.stringify(report,null,2)+"\n");
 const lines=["# Sentinel Prime — Source Snapshot Report","","- Fetched: "+report.fetchedAt,"- Markets checked: "+markets.length,"- URLs attempted: "+results.length,"- Submissions left this UTC hour: "+limits.data.submitsLeftThisHour,"> Read-only archive. Fetch time is not publication time; unknown dates require manual verification.","","| Status | HTTP | Bytes | Published | SHA-256 | Market | URL |","|---|---:|---:|---|---|---|---|"];
 for(const r of results)lines.push("| "+r.status+" | "+(r.httpStatus??"—")+" | "+r.bytes+" | "+(r.publishedAt??"unknown")+" | "+(r.sha256??"—")+" | "+r.marketQuestion.replaceAll("|","\|")+" | "+r.url+" |");
 lines.push("","## Required review","- Verify visible publication date and original context.","- Compare publication date to the market's strict novelty boundary.","- Check corrections, syndication, contradictions and exact resolution relevance.","- A hash proves snapshot integrity, not claim truth.","- No evidence submitted.");
 await writeFile(join(ROOT,"source-snapshots.md"),lines.join("\n")+"\n");
 console.log("Archived "+results.filter(x=>x.status==="fetched").length+" of "+results.length+" sources, including RSS/Atom-discovered article URLs.");
 console.log("robots blocked "+results.filter(x=>x.status==="blocked_robots").length+"; skipped "+results.filter(x=>x.status==="skipped").length+"; failed "+results.filter(x=>x.status==="failed").length);
 console.log("No evidence submitted.");
}
main().catch(e=>{console.error("Source snapshot failed:",e instanceof Error?e.message:"Unknown error");process.exit(1);});
