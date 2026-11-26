import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";

type Market = {
  address: string; question: string; status: string;
  odds: { yes: number; no: number };
  evidenceCutoffAt: string; closesAt: string;
  category?: string; categoryLabel?: string; marketTier?: string;
  dataSources?: string[]; resolutionCriteria?: string; delphiUrl?: string;
};
type ResearchTask = {
  marketAddress: string; question: string; category: string;
  yesProbability: number; cutoffAt: string; hoursToCutoff: number;
  canSubmit: boolean; entryReason: string | null; remainingOnMarket: number | null;
  judgmentPotRemainingBaseUnits: string | null;
  noveltyFloor: string | null;
  noveltyFloorMeaning: string;
  sourceTargets: string[];
  questions: string[];
  hardStops: string[];
  marketUrl: string | null;
};
const BASE="https://delphi.fyi/v1";
const MARKET_URL="https://competition.delphi.fyi/markets.json";
const OUT=process.env.REPORT_DIR || "reports";
const MIN_HOURS=2;
const MAX_MARKETS=8;

function probability(n:number):number {
  const p=n>1?n/100:n;
  if(!Number.isFinite(p)||p<0||p>1) throw new Error("Invalid probability in markets feed.");
  return p;
}
function listMarkets(body:unknown):Market[] {
  const raw=Array.isArray(body)?body:
    (typeof body==="object"&&body!==null&&Array.isArray((body as {markets?:unknown[]}).markets)
      ?(body as {markets:unknown[]}).markets:null);
  if(!raw) throw new Error("Unexpected markets.json schema.");
  return raw.map((v,i)=>{
    if(typeof v!=="object"||v===null) throw new Error("Invalid market at index "+i);
    const m=v as Market;
    if(!m.address||!m.question||!m.status||!m.odds||typeof m.odds.yes!=="number"||
      !m.evidenceCutoffAt||!Number.isFinite(Date.parse(m.evidenceCutoffAt))) {
      throw new Error("Market at index "+i+" is missing required fields.");
    }
    probability(m.odds.yes);
    return m;
  });
}
function noveltyFloor(criteria?:string):string|null {
  if(!criteria) return null;
  const match=criteria.match(/(?:published|confirmed|completed) strictly after (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/i);
  return match?.[1]??null;
}
function playbook(m:Market):{questions:string[];stops:string[]} {
  const category=m.category??"";
  const shared=[
    "Find a dated fact published strictly after the market's explicit resolution-window lower bound.",
    "Map the fact to the exact resolver, metric, threshold, unit and publication window; do not substitute a related metric.",
    "Search for corrections, contradictions and independent corroboration before staging anything."
  ];
  const map:Record<string,{questions:string[];stops:string[]}>={
    votes_government:{
      questions:["Has the official authority published any new procedural notice, ballot-material count, postal-vote update or verified turnout indicator since the novelty floor?","Have municipalities/cantons published official participation or ballot-processing updates that can be tied to the exact referendum?","Has the responsible authority changed the official publication timetable or definition of the resolving metric?"],
      stops:["Do not use the election result before the evidence cutoff; it occurs after the cutoff.","Historical turnout and polls published before the novelty floor are not new evidence."]
    },
    local_language:{
      questions:["What new primary-language official notice, party filing, electoral administration update or procedural event appeared after the novelty floor?","Can the relevant local authority's original page or PDF be fetched and dated, rather than relying on an English summary?","Does the fact directly affect the named party's seat count or the exact parliamentary vote?"],
      stops:["Do not treat polling projections as the official provisional seat count.","Reject pre-floor polls even if republished in a new article."]
    },
    official_statistics:{
      questions:["Which official high-frequency sub-indicators for the same basket/metric were released after the novelty floor?","Did the statistical office publish a methodology, seasonal-adjustment, basket-weight or release-calendar update?","Are the indicators directly comparable to the exact preliminary/final series named in the market?"],
      stops:["Do not substitute harmonised CPI for national CPI, monthly for annual, or revised for first-print data.","The scheduled release itself is not evidence of the numerical result."]
    },
    releases_standards:{
      questions:["Did the official Datatracker record a new ballot position, DISCUSS, telechat action or document revision after the novelty floor?","Does the current ballot page show a formal DISCUSS position, not merely a comment or review request?","Can the document history and ballot state be independently reconciled on the IETF Datatracker?"],
      stops:["A draft revision, review assignment or agenda listing is not itself a DISCUSS ballot.","A ballot page snapshot without a publication timestamp cannot prove when a status first appeared."]
    },
    niche_communities:{
      questions:["Has the official organiser published a new schedule, participant list, score, leaderboard or eligibility ruling after the novelty floor?","Does the source report the exact entity and metric used by the market's resolution criteria?","Is the result public and independently verifiable without login or access circumvention?"],
      stops:["Do not use unofficial fan accounts as settlement authority.","Do not substitute public leaderboard data when the market resolves on a private leaderboard."]
    },
    controls:{
      questions:["Has the official agency published a new calendar, policy statement, speaker schedule or procedural update after the novelty floor?","Is there a primary-source leading indicator that bears directly on the exact resolving statistic?","Can the source establish publication time and preserve the original release?"],
      stops:["Do not submit forecasts or analyst opinions as facts.","Do not substitute a revised statistic for a first-print figure."]
    }
  };
  const p=map[category]??{questions:["Identify the official resolver and exact resolving metric.","Find new primary-source facts published after the novelty floor.","Verify dates, units, contradictions and direct resolution relevance."],stops:["Skip if the source date or resolution mapping cannot be verified."]};
  return {questions:[...shared,...p.questions],stops:p.stops};
}
async function main(){
  const key=process.env.DELPHI_API_ACCESS_KEY;
  if(!key) throw new Error("DELPHI_API_ACCESS_KEY is missing.");
  const client=new EvidenceClient({baseUrl:BASE,apiKey:key,agentId:"sentinel-prime",agentHarness:"Bilalsnz/Sentinel-",agentModel:"sentinel-prime-research-planner"});
  const [termsRes,limitsRes,feed]=await Promise.all([client.getTerms(),client.getLimits(),fetch(MARKET_URL,{signal:AbortSignal.timeout(20000)})]);
  if(!feed.ok) throw new Error("markets.json returned HTTP "+feed.status);
  const markets=listMarkets(await feed.json());
  const now=Date.now();
  const eligible=markets.filter(m=>{
    const p=probability(m.odds.yes);
    const hours=(Date.parse(m.evidenceCutoffAt)-now)/3600000;
    return m.status==="open"&&hours>=MIN_HOURS&&p>=0.2&&p<=0.8;
  }).sort((a,b)=>Date.parse(a.evidenceCutoffAt)-Date.parse(b.evidenceCutoffAt)).slice(0,MAX_MARKETS);
  const tasks:ResearchTask[]=[];
  for(const m of eligible){
    const entry=await client.getEntryState(m.address);
    const hours=(Date.parse(m.evidenceCutoffAt)-now)/3600000;
    const pb=playbook(m);
    const canSubmit=Boolean(entry.data.canSubmit);
    const hardStops=[...pb.stops];
    if(!termsRes.data.acceptedAt) hardStops.push("Current Delphi terms are not accepted; stop.");
    if(!canSubmit) hardStops.push("Delphi entry-state gate failed: "+(entry.data.reason??"cannot submit")+".");
    if(hours<MIN_HOURS) hardStops.push("Evidence cutoff is less than two hours away.");
    if(!m.dataSources?.length) hardStops.push("No official or suggested source targets are listed.");
    tasks.push({
      marketAddress:m.address,question:m.question,category:m.category??"uncategorized",
      yesProbability:probability(m.odds.yes),cutoffAt:m.evidenceCutoffAt,
      hoursToCutoff:Math.round(hours*10)/10,canSubmit,
      entryReason:entry.data.reason??null,
      remainingOnMarket:entry.data.remainingOnMarket??null,
      judgmentPotRemainingBaseUnits:entry.data.judgementPotRemainingBaseUnits??null,
      noveltyFloor:noveltyFloor(m.resolutionCriteria),
      noveltyFloorMeaning:"Exact 'published/confirmed/completed strictly after' boundary from the market resolution criteria. Treat as the admissibility lower bound; it is not independently asserted to equal the forecaster's view timestamp.",
      sourceTargets:(m.dataSources??[]),
      questions:pb.questions,hardStops,marketUrl:m.delphiUrl??null
    });
    await new Promise(r=>setTimeout(r,300));
  }
  const report={agent:"sentinel-prime",mode:"read-only-research-planning",generatedAt:new Date().toISOString(),
    competitionMarketsUrl:MARKET_URL,totalMarkets:markets.length,plannedMarkets:tasks.length,
    terms:{version:termsRes.data.version,acceptedAt:termsRes.data.acceptedAt},
    limits:limitsRes.data,researchTasks:tasks,
    safety:{evidenceSubmitted:false,termsChanged:false,sourcePagesNotFetched:true,allTasksRequireSourceVerification:true}};
  await mkdir(OUT,{recursive:true});
  await writeFile(join(OUT,"research-plan.json"),JSON.stringify(report,null,2)+"\n");
  const md=["# Sentinel Prime — Research Plan","",
    "- Generated: "+report.generatedAt,"- Markets in feed: "+markets.length,
    "- Markets planned: "+tasks.length,"- Terms accepted: "+Boolean(termsRes.data.acceptedAt),
    "- Submissions left this UTC hour: "+limitsRes.data.submitsLeftThisHour,
    "> Planning only. This workflow does not fetch source pages or submit evidence.","",
    "| Market | Category | YES | Hours to cutoff | Entry | Remaining | Novelty floor |",
    "|---|---|---:|---:|---|---:|---|"];
  for(const t of tasks) md.push("| ["+t.question.replaceAll("|","\\|")+"]("+(t.marketUrl??"#")+") | "+t.category+" | "+(t.yesProbability*100).toFixed(1)+"% | "+t.hoursToCutoff+" | "+(t.canSubmit?"YES":"NO")+" | "+(t.remainingOnMarket??"—")+" | "+(t.noveltyFloor??"not parsed")+" |");
  for(const t of tasks){
    md.push("","## "+t.question,"","- Market address: "+t.marketAddress,
      "- Cutoff: "+t.cutoffAt,"- Entry state: "+(t.canSubmit?"can submit":"blocked")+"; remaining slots: "+(t.remainingOnMarket??"unknown"),
      "- Novelty boundary: "+(t.noveltyFloor??"not parsed"),
      "- Boundary caution: "+t.noveltyFloorMeaning,"- Source targets: "+(t.sourceTargets.join(", ")||"none"),"","### Research questions");
    for(const q of t.questions) md.push("- "+q);
    md.push("","### Hard stops");
    for(const s of t.hardStops) md.push("- "+s);
  }
  md.push("","## Safety","- No evidence submitted.","- No source page fetched in this planning run.","- Every candidate must pass source date, exact resolution relevance, novelty, corroboration and duplicate checks.");
  await writeFile(join(OUT,"research-plan.md"),md.join("\n")+"\n");
  console.log("Research plan generated for "+tasks.length+" eligible markets.");
  console.log("Submissions left this UTC hour: "+limitsRes.data.submitsLeftThisHour);
  for(const t of tasks) console.log((t.canSubmit?"[OPEN]":"[BLOCKED]")+" "+t.category+" | "+t.hoursToCutoff+"h | "+t.question);
  console.log("No evidence submitted.");
}
main().catch(e=>{console.error("Research planning failed:",e instanceof Error?e.message:"Unknown error");process.exit(1);});
