import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Market = {
  address: string; question: string; status: string;
  odds: { yes: number; no: number };
  evidenceCutoffAt: string; closesAt: string;
  category?: string; categoryLabel?: string; marketTier?: string;
  wave?: number; dataSources?: string[]; resolutionCriteria?: string;
  delphiUrl?: string; pots?: { judgement?: string; settlement?: string };
};

type Row = {
  address: string; question: string; status: string; category: string;
  tier: string; yes: number; no: number; cutoff: string; closes: string;
  hoursToCutoff: number; sources: string[]; marketUrl: string | null;
  resolutionWindowStart: string | null; resolutionWindowStartVerifiedAsForecasterView: false;
  researchPriorityScore: number; priority: "P0" | "P1" | "P2" | "SKIP"; reasons: string[];
};

const SOURCE_URL = process.env.COMPETITION_MARKETS_URL || "https://competition.delphi.fyi/markets.json";
const OUT = process.env.REPORT_DIR || "reports";
const MIN_HOURS = 2;

function probability(value: number): number {
  const p = value > 1 ? value / 100 : value;
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error("Invalid market probability: " + value);
  return p;
}

function parseMarkets(body: unknown): Market[] {
  const list = Array.isArray(body) ? body :
    (typeof body === "object" && body !== null && Array.isArray((body as {markets?: unknown[]}).markets)
      ? (body as {markets: unknown[]}).markets : null);
  if (!list) throw new Error("Unexpected markets.json schema.");
  return list.map((v, i) => {
    if (typeof v !== "object" || v === null) throw new Error("Invalid market at index " + i);
    const m = v as Market;
    if (!m.address || !m.question || !m.status || !m.odds ||
        typeof m.odds.yes !== "number" || typeof m.odds.no !== "number" ||
        !m.evidenceCutoffAt || !m.closesAt ||
        !Number.isFinite(Date.parse(m.evidenceCutoffAt)) || !Number.isFinite(Date.parse(m.closesAt))) {
      throw new Error("Market at index " + i + " is missing required fields or valid timestamps.");
    }
    probability(m.odds.yes); probability(m.odds.no);
    return m;
  });
}

function resolutionStart(text?: string): string | null {
  if (!text) return null;
  const re = /(?:published|confirmed|completed) strictly after (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/i;
  return text.match(re)?.[1] || null;
}

function scan(m: Market, now: number): Row {
  const yes = probability(m.odds.yes);
  const no = probability(m.odds.no);
  const hours = (Date.parse(m.evidenceCutoffAt) - now) / 3600000;
  const sources = Array.isArray(m.dataSources) ? m.dataSources.filter(x => typeof x === "string") : [];
  const balance = Math.max(0, 100 * (1 - Math.abs(yes - 0.5) / 0.5));
  const timing = hours < MIN_HOURS ? 0 : hours <= 12 ? 55 : hours <= 48 ? 100 : hours <= 120 ? 85 : hours <= 240 ? 65 : 45;
  const sourceCoverage = Math.min(sources.length / 2, 1) * 100;
  const tier = m.marketTier === "A" ? 100 : m.marketTier === "B" ? 75 : 50;
  const score = Math.round(balance * 0.35 + timing * 0.30 + sourceCoverage * 0.20 + tier * 0.15);
  const open = m.status.toLowerCase() === "open";
  const cutoffOk = hours >= MIN_HOURS;
  const oddsOk = yes >= 0.2 && yes <= 0.8;
  let priority: Row["priority"] = "SKIP";
  if (open && cutoffOk && oddsOk) priority = score >= 75 ? "P0" : score >= 55 ? "P1" : "P2";
  const reasons: string[] = [];
  if (!open) reasons.push("Market is not open.");
  if (!cutoffOk) reasons.push("Cutoff is less than two hours away or has passed.");
  if (!oddsOk) reasons.push("YES odds are outside the 20%-80% research band.");
  if (sources.length === 0) reasons.push("No suggested sources are listed.");
  if (hours >= MIN_HOURS && hours <= 48) reasons.push("Near-term cutoff: investigate only if a verifiable pre-cutoff fact exists.");
  if (hours > 48 && hours <= 120) reasons.push("Useful research window for leading indicators and official source cadence.");
  if (!reasons.length) reasons.push("Eligible for exploratory research triage only.");
  return {
    address: m.address, question: m.question, status: m.status,
    category: m.category || "uncategorized", tier: m.marketTier || "unknown",
    yes, no, cutoff: m.evidenceCutoffAt, closes: m.closesAt,
    hoursToCutoff: Math.round(hours * 10) / 10, sources,
    marketUrl: m.delphiUrl || null,
    resolutionWindowStart: resolutionStart(m.resolutionCriteria),
    resolutionWindowStartVerifiedAsForecasterView: false,
    researchPriorityScore: score, priority, reasons
  };
}

async function main() {
  const fetchedAt = new Date().toISOString();
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error("markets.json returned HTTP " + response.status);
  const raw = await response.text();
  const hash = createHash("sha256").update(raw).digest("hex");
  const markets = parseMarkets(JSON.parse(raw)).map(m => scan(m, Date.now()));
  const rank = { P0: 0, P1: 1, P2: 2, SKIP: 3 };
  markets.sort((a, b) => rank[a.priority] - rank[b.priority] || b.researchPriorityScore - a.researchPriorityScore);
  await mkdir(OUT, { recursive: true });
  const report = {
    agent: "sentinel-prime", mode: "read-only-market-triage", fetchedAt,
    sourceUrl: SOURCE_URL, sourceSha256: hash, totalMarkets: markets.length,
    eligibleMarkets: markets.filter(m => m.priority !== "SKIP").length, markets,
    safety: { evidenceSubmitted: false, delphiApiCalled: false,
      resolutionWindowStartVerifiedAsForecasterView: false,
      scoreIsEvidenceQualityOrPrediction: false }
  };
  await writeFile(join(OUT, "market-scan.json"), JSON.stringify(report, null, 2) + "\n");
  const lines = [
    "# Sentinel Prime — Market Scan", "",
    "- Fetched at: " + fetchedAt,
    "- Markets: " + markets.length,
    "- Eligible for research triage: " + report.eligibleMarkets,
    "- Source SHA-256: " + hash, "",
    "> This is a market-triage report, not a forecast or evidence-quality assessment. No Delphi API calls or submissions are made.",
    "> The score ranks operational research opportunity only; it is not a probability, novelty score or expected bounty.",
    "> The parsed resolution timestamp is NOT verified as the forecaster-view timestamp. Do not use it as a novelty floor without authoritative verification.", "",
    "| Priority | Score | Category | YES | Hours to cutoff | Sources | Market question |",
    "|---|---:|---|---:|---:|---:|---|"
  ];
  for (const m of markets.filter(x => x.priority !== "SKIP")) {
    lines.push("| " + m.priority + " | " + m.researchPriorityScore + " | " + m.category +
      " | " + (m.yes * 100).toFixed(1) + "% | " + m.hoursToCutoff + " | " +
      m.sources.length + " | [" + m.question.replaceAll("|", "\\|") + "](" + (m.marketUrl || "#") + ") |");
  }
  lines.push("", "## Market notes", "");
  for (const m of markets.filter(x => x.priority !== "SKIP")) {
    lines.push("### " + m.priority + " — " + m.question);
    lines.push("- Address: " + m.address);
    lines.push("- Evidence cutoff: " + m.cutoff);
    lines.push("- Resolution-window timestamp (unverified): " + (m.resolutionWindowStart || "not parsed"));
    lines.push("- Suggested sources: " + (m.sources.join(", ") || "none"));
    lines.push("- Triage notes: " + m.reasons.join(" "));
    lines.push("");
  }
  lines.push("## Next-stage safety", "",
    "- Check Delphi entry state before researching a market.",
    "- Verify the actual forecaster-view timestamp; do not assume the resolution-criteria timestamp is equivalent.",
    "- Research only facts published after the verified timestamp.",
    "- This workflow never submits evidence.");
  await writeFile(join(OUT, "market-scan.md"), lines.join("\n") + "\n");
  console.log("Fetched " + markets.length + " markets; " + report.eligibleMarkets + " eligible for research triage.");
  console.log("Source SHA-256: " + hash);
  for (const m of markets.filter(x => x.priority !== "SKIP").slice(0, 10)) {
    console.log("[" + m.priority + " " + m.researchPriorityScore + "] " + m.hoursToCutoff + "h | " + m.category + " | " + m.question);
  }
  console.log("Reports written to " + OUT + ". No Delphi API calls or submissions were made.");
}

main().catch((error: unknown) => {
  console.error("Market scan failed:", error instanceof Error ? error.message : "Unknown error");
  process.exit(1);
});
