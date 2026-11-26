import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Market = { address: string; question: string; status: string; evidenceCutoffAt: string; dataSources?: string[] };
type Snapshot = { marketAddress: string; url: string; status: string; sha256: string | null; publishedAt: string | null; file: string | null; reason: string | null; [key: string]: unknown };
type Lead = { url: string; discoveredFrom: string; title?: string };
const REPORTS = process.env.REPORT_DIR || "reports";
const MARKET_FEED = "https://competition.delphi.fyi/markets.json";
const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";
const UA = "SentinelPrimeEvidenceResearch/0.1 (+https://github.com/Bilalsnz/Sentinel-)";
const MAX_BYTES = 2_000_000;
const MAX_LEADS_PER_MARKET = 5;
const STOP = new Set("about after again against also among another any are because been before being between both could does during each from further have into just more most other over same should some such than that their there these they this those through under until very what when where which while with would will".split(" "));

function marketsOf(value: unknown): Market[] {
  const rows = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { markets?: unknown[] }).markets) ? (value as { markets: unknown[] }).markets : [];
  return rows as Market[];
}
function terms(question: string): string[] {
  return [...new Set((question.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []).filter(x => !STOP.has(x)))].slice(0, 5);
}
function safeUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname || /^(localhost|.*\.local|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname)) return null;
    return u;
  } catch { return null; }
}
function robotsAllows(text: string, path: string): boolean {
  let active = false;
  const rules: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const clean = line.split("#")[0].trim();
    const at = clean.indexOf(":");
    if (at < 0) continue;
    const key = clean.slice(0, at).trim().toLowerCase();
    const value = clean.slice(at + 1).trim();
    if (key === "user-agent") active = value === "*" || value.toLowerCase().includes("sentinel");
    else if (active && key === "disallow" && value) rules.push(value);
  }
  return !rules.some(rule => path.startsWith(rule));
}
async function readLimited(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Source exceeds 2 MB limit"); }
    chunks.push(part.value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
function publishedAt(html: string): string | null {
  const values: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)) attrs.set(match[1].toLowerCase(), match[2]);
    const key = (attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop") ?? "").toLowerCase();
    if (["article:published_time", "og:published_time", "datepublished", "pubdate", "publishdate"].includes(key)) {
      const value = attrs.get("content") ?? attrs.get("value");
      if (value) values.push(value);
    }
  }
  for (const match of html.matchAll(/"(?:datePublished|published_at|publishedAt|publish_date)"\s*:\s*"([^"]+)"/gi)) values.push(match[1]);
  for (const value of values) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return new Date(time).toISOString();
  }
  return null;
}
async function robots(u: URL): Promise<string | null> {
  try {
    const response = await fetch(new URL("/robots.txt", u.origin), { headers: { "User-Agent": UA }, redirect: "error", signal: AbortSignal.timeout(8000) });
    if (response.status === 404) return "";
    if (!response.ok) return null;
    return await response.text();
  } catch { return null; }
}
async function gdeltLeads(market: Market): Promise<Lead[]> {
  const keywords = terms(market.question);
  if (keywords.length < 2) return [];
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 86400000);
  const fmt = (d: Date) => d.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const query = "(" + keywords.map(x => '"' + x.replace(/"/g, "") + '"').join(" OR ") + ")";
  const endpoint = new URL(GDELT);
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("mode", "ArtList");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("maxrecords", String(MAX_LEADS_PER_MARKET));
  endpoint.searchParams.set("sort", "DateDesc");
  endpoint.searchParams.set("startdatetime", fmt(start));
  endpoint.searchParams.set("enddatetime", fmt(now));
  try {
    const response = await fetch(endpoint, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return [];
    const data = await response.json() as { articles?: Array<{ url?: string; title?: string }> };
    return (data.articles ?? []).flatMap(article => {
      const u = article.url ? safeUrl(article.url) : null;
      return u ? [{ url: u.toString(), discoveredFrom: "GDELT DOC 2.0 (discovery lead only)", title: article.title }] : [];
    });
  } catch { return []; }
}
async function rssLeads(seedUrls: string[], question: string): Promise<Lead[]> {
  const origins = [...new Set(seedUrls.flatMap(raw => { const u = safeUrl(raw); return u ? [u.origin] : []; }))].slice(0, 8);
  const found: Lead[] = [];
  const paths = ["/feed/", "/feed.xml", "/rss", "/rss.xml", "/atom.xml"];
  const q = new Set(terms(question));
  for (const origin of origins) {
    const root = safeUrl(origin);
    if (!root) continue;
    const policy = await robots(root);
    if (policy === null) continue;
    for (const path of paths) {
      if (!robotsAllows(policy, path)) continue;
      try {
        const response = await fetch(new URL(path, origin), { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, redirect: "error", signal: AbortSignal.timeout(8000) });
        if (!response.ok) continue;
        const xml = await response.text();
        if (xml.length > 1_000_000) continue;
        const entries = [...xml.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)];
        for (const entry of entries) {
          const block = entry[1];
          const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").trim();
          const href = block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ?? block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? "";
          const link = href.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
          const u = safeUrl(new URL(link, new URL(path, origin)).toString());
          if (!u || u.hostname !== root.hostname) continue;
          const titleTerms = new Set(terms(title));
          const overlap = [...q].filter(x => titleTerms.has(x)).length / Math.max(1, q.size);
          if (title && overlap >= 0.2) found.push({ url: u.toString(), discoveredFrom: "Publisher RSS/Atom: " + origin, title });
        }
      } catch { /* A failed feed is a skipped lead, never evidence. */ }
    }
  }
  return found;
}
async function main() {
  const [marketResponse, snapshotText] = await Promise.all([
    fetch(MARKET_FEED, { signal: AbortSignal.timeout(20000) }),
    readFile(join(REPORTS, "source-snapshots.json"), "utf8")
  ]);
  if (!marketResponse.ok) throw new Error("markets.json HTTP " + marketResponse.status);
  const markets = marketsOf(await marketResponse.json()).filter(m => m.status === "open" && Date.parse(m.evidenceCutoffAt) > Date.now());
  const existingReport = JSON.parse(snapshotText) as { sources: Snapshot[]; [key: string]: unknown };
  const existing = new Set(existingReport.sources.map(s => s.url));
  const all: Array<{ market: Market; lead: Lead }> = [];
  for (const market of markets) {
    const seeds = market.dataSources ?? [];
    const leads = [...await gdeltLeads(market), ...await rssLeads(seeds, market.question)];
    const perMarket = new Set<string>();
    for (const lead of leads) {
      if (existing.has(lead.url) || perMarket.has(lead.url)) continue;
      perMarket.add(lead.url);
      all.push({ market, lead });
      if (perMarket.size >= MAX_LEADS_PER_MARKET) break;
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  const added: Snapshot[] = [];
  await mkdir(join(REPORTS, "source-snapshots"), { recursive: true });
  const robotsCache = new Map<string, string | null>();
  for (const { market, lead } of all.slice(0, 90)) {
    const u = safeUrl(lead.url);
    if (!u) continue;
    let policy = robotsCache.get(u.origin);
    if (policy === undefined) { policy = await robots(u); robotsCache.set(u.origin, policy); }
    const row: Snapshot = { marketAddress: market.address, url: u.toString(), status: "failed", sha256: null, publishedAt: null, file: null, reason: null, discoveredFrom: lead.discoveredFrom, title: lead.title ?? null, fetchedAt: new Date().toISOString() };
    try {
      if (policy === null) { row.status = "skipped"; row.reason = "robots.txt unavailable; fail closed"; added.push(row); continue; }
      if (!robotsAllows(policy, u.pathname)) { row.status = "blocked_robots"; row.reason = "robots.txt disallows path"; added.push(row); continue; }
      const response = await fetch(u, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/json;q=0.9" }, redirect: "error", signal: AbortSignal.timeout(12000) });
      if (!response.ok) { row.reason = "HTTP " + response.status; added.push(row); continue; }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!(contentType.includes("html") || contentType.includes("json") || contentType.startsWith("text/"))) { row.reason = "Unsupported content type: " + contentType; added.push(row); continue; }
      const body = await readLimited(response);
      row.sha256 = createHash("sha256").update(body).digest("hex");
      row.publishedAt = publishedAt(new TextDecoder().decode(body));
      const ext = contentType.includes("json") ? ".json" : ".html";
      const filename = "free-" + row.sha256.slice(0, 20) + ext;
      await writeFile(join(REPORTS, "source-snapshots", filename), body);
      row.file = "source-snapshots/" + filename;
      row.status = "fetched";
      if (!row.publishedAt) row.reason = "Archived as a discovery lead; no verifiable publication timestamp found";
    } catch (error) { row.reason = error instanceof Error ? error.message : "Unknown fetch error"; }
    added.push(row);
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  existingReport.sources.push(...added);
  existingReport.freeDiscovery = { provider: ["GDELT DOC 2.0", "publisher RSS/Atom"], generatedAt: new Date().toISOString(), marketsConsidered: markets.length, leadsFetched: added.filter(x => x.status === "fetched").length, leadsWithoutPublicationDate: added.filter(x => x.status === "fetched" && !x.publishedAt).length, blockedOrFailed: added.filter(x => x.status !== "fetched").length, paidProviders: false, apiKeysRequired: false };
  await writeFile(join(REPORTS, "source-snapshots.json"), JSON.stringify(existingReport, null, 2) + "\n");
  const report = { ...existingReport.freeDiscovery, leads: added.map(x => ({ marketAddress: x.marketAddress, url: x.url, discoveredFrom: x.discoveredFrom, title: x.title, status: x.status, publishedAt: x.publishedAt, reason: x.reason })) };
  await writeFile(join(REPORTS, "free-discovery-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("Free discovery complete: " + added.filter(x => x.status === "fetched").length + " additional pages archived from GDELT/RSS leads. GDELT timestamps were not treated as publication dates; page publication metadata is required for candidate eligibility. No paid provider or API key used.");
}
main().catch(error => { console.error("Free discovery failed:", error instanceof Error ? error.message : "Unknown error"); process.exit(1); });
