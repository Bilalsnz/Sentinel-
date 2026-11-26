import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";

type Market = {
  address: string; question: string; status: string;
  odds: { yes: number; no: number };
  evidenceCutoffAt: string; delphiUrl?: string;
};

const API_BASE = "https://delphi.fyi/v1";
const MARKETS_URL = "https://competition.delphi.fyi/markets.json";
const AGENT_ID = "sentinel-prime";
const AGENT_HARNESS = "Bilalsnz/Sentinel-";
const AGENT_MODEL = "sentinel-prime-market-preflight";

function normalize(p: number): number {
  const value = p > 1 ? p / 100 : p;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid probability in market feed.");
  return value;
}

async function main() {
  const apiKey = process.env.DELPHI_API_ACCESS_KEY;
  if (!apiKey) throw new Error("DELPHI_API_ACCESS_KEY is missing. Set it as a GitHub Actions secret; never paste it into logs or chat.");

  const client = new EvidenceClient({
    baseUrl: API_BASE,
    apiKey,
    agentId: AGENT_ID,
    agentHarness: AGENT_HARNESS,
    agentModel: AGENT_MODEL
  });

  console.log("Sentinel Prime authenticated preflight: read-only; no terms acceptance or submissions.");
  const [limitsResult, termsResult, marketResponse] = await Promise.all([
    client.getLimits(),
    client.getTerms(),
    fetch(MARKETS_URL, { signal: AbortSignal.timeout(20000) })
  ]);
  if (!marketResponse.ok) throw new Error("markets.json returned HTTP " + marketResponse.status);
  const raw = await marketResponse.text();
  const marketsHash = createHash("sha256").update(raw).digest("hex");
  const body: unknown = JSON.parse(raw);
  const list = Array.isArray(body) ? body :
    (typeof body === "object" && body !== null && Array.isArray((body as {markets?: unknown[]}).markets)
      ? (body as {markets: unknown[]}).markets : null);
  if (!list) throw new Error("Unexpected markets.json schema.");

  const terms = termsResult.data;
  if (!terms.acceptedAt) {
    console.error("STOP: current Delphi terms are not accepted. Review " + terms.url + " and obtain explicit owner approval before accepting.");
    process.exit(2);
  }

  const now = Date.now();
  const eligible = (list as Market[]).filter(m => {
    if (!m || m.status !== "open" || !m.odds || typeof m.odds.yes !== "number") return false;
    const hours = (Date.parse(m.evidenceCutoffAt) - now) / 3600000;
    const yes = normalize(m.odds.yes);
    return hours >= 2 && yes >= 0.2 && yes <= 0.8;
  }).sort((a, b) => Date.parse(a.evidenceCutoffAt) - Date.parse(b.evidenceCutoffAt))
    .slice(0, 8);

  const entryStates = [];
  for (const market of eligible) {
    try {
      const result = await client.getEntryState(market.address);
      entryStates.push({
        address: market.address,
        question: market.question,
        marketUrl: market.delphiUrl ?? null,
        evidenceCutoffAt: market.evidenceCutoffAt,
        yesProbability: normalize(market.odds.yes),
        canSubmit: result.data.canSubmit,
        reason: result.data.reason ?? null,
        remainingOnMarket: result.data.remainingOnMarket,
        restricted: result.data.restricted ?? false,
        judgementPotRemainingBaseUnits: result.data.judgementPotRemainingBaseUnits,
        rateLimitResetAt: result.data.rateLimit.resetAt,
        requestId: result.meta.requestId ?? null
      });
    } catch (error) {
      entryStates.push({
        address: market.address,
        question: market.question,
        canSubmit: false,
        error: error instanceof Error ? error.message : "Unknown entry-state error"
      });
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }

  const report = {
    agent: AGENT_ID,
    mode: "authenticated-read-only-entry-preflight",
    fetchedAt: new Date().toISOString(),
    marketsUrl: MARKETS_URL,
    marketsSha256: marketsHash,
    terms: { version: terms.version, acceptedAt: terms.acceptedAt, url: terms.url },
    limits: limitsResult.data,
    checkedMarkets: entryStates.length,
    entryStates,
    safety: {
      evidenceSubmitted: false,
      termsAcceptedOrChanged: false,
      marketEntryStateChecked: true
    }
  };

  const outDir = process.env.REPORT_DIR || "reports";
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "entry-preflight.json"), JSON.stringify(report, null, 2) + "\n");
  const lines = [
    "# Sentinel Prime — Authenticated Entry Preflight", "",
    "- Checked at: " + report.fetchedAt,
    "- Terms: " + terms.version + " (accepted " + terms.acceptedAt + ")",
    "- Submissions left this UTC hour: " + limitsResult.data.submitsLeftThisHour,
    "- Daily cap remaining: " + limitsResult.data.dailyCapLeft,
    "- Markets checked: " + entryStates.length, "",
    "> Read-only. No terms were accepted and no evidence was submitted.", "",
    "| Can submit | Remaining | Restricted | Cutoff | Market | Reason |",
    "|---|---:|---|---|---|---|"
  ];
  for (const item of entryStates) {
    lines.push("| " + (item.canSubmit ? "YES" : "NO") + " | " +
      ("remainingOnMarket" in item ? item.remainingOnMarket : "—") + " | " +
      ("restricted" in item ? String(item.restricted) : "—") + " | " +
      ("evidenceCutoffAt" in item ? item.evidenceCutoffAt : "—") + " | " +
      item.question.replaceAll("|", "\\|") + " | " +
      ("reason" in item ? (item.reason || "—") : ("error" in item ? item.error : "—")) + " |");
  }
  await writeFile(join(outDir, "entry-preflight.md"), lines.join("\n") + "\n");
  console.log("Authenticated read-only preflight complete. Checked " + entryStates.length + " markets.");
  console.log("Submissions remaining this UTC hour: " + limitsResult.data.submitsLeftThisHour);
  console.log("Evidence submitted: 0.");
}

main().catch((error: unknown) => {
  console.error("Entry preflight failed:", error instanceof Error ? error.message : "Unknown error");
  process.exit(1);
});
