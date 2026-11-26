import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";

const BASE = "https://delphi.fyi/v1";
const REPORT_DIR = process.env.REPORT_DIR || "reports";
const CANDIDATES_FILE = process.env.CANDIDATES_FILE || "candidate-staging.json";
const APPROVED_ID = "US-NFP-ADP-PULSE-2026-11-24";
const MARKET = "0x6d14f2291c886a3469e988a7f80d307802a40c0a";

type Candidate = {
  id: string; marketAddress: string; claim: string; sourceUrl: string;
  resolutionMapping: string; humanVerified: boolean; verificationNote: string;
};
type Validation = {
  generatedAt: string; terms: { version: string; acceptedAt: string | null };
  passed: number; blocked: number;
  candidates: { id: string; passed: boolean; gates: { name: string; passed: boolean }[] }[];
};

async function main() {
  const key = process.env.DELPHI_API_ACCESS_KEY;
  if (!key) throw new Error("DELPHI_API_ACCESS_KEY missing");
  const report = JSON.parse(await readFile(join(REPORT_DIR, "candidate-validation.json"), "utf8")) as Validation;
  const age = Date.now() - Date.parse(report.generatedAt);
  if (!Number.isFinite(age) || age < 0 || age > 10 * 60_000) throw new Error("Validation report is stale; refusing submission.");
  const checked = report.candidates.find(x => x.id === APPROVED_ID);
  if (!checked?.passed || checked.gates.some(g => !g.passed)) throw new Error("Approved candidate did not pass every validation gate.");
  const candidates = JSON.parse(await readFile(CANDIDATES_FILE, "utf8")) as Candidate[];
  const candidate = candidates.find(x => x.id === APPROVED_ID);
  if (!candidate || candidate.marketAddress.toLowerCase() !== MARKET || candidate.humanVerified !== true || !candidate.verificationNote.trim()) {
    throw new Error("Approved candidate or its human-verification record is missing.");
  }

  const client = new EvidenceClient({
    baseUrl: BASE, apiKey: key,
    agentId: "sentinel-prime",
    agentHarness: "Bilalsnz/Sentinel-",
    agentModel: "sentinel-prime-evidence-agent",
  });

  // Recheck live account state immediately before the write. Never accept changed terms here.
  const [terms, limits, entry] = await Promise.all([
    client.getTerms(), client.getLimits(), client.getEntryState(MARKET),
  ]);
  if (!terms.data.acceptedAt || terms.data.version !== report.terms.version) {
    throw new Error("Current Delphi terms are not the already-accepted version; refusing submission.");
  }
  if (!limits.data.submitsLeftThisHour || limits.data.submitsLeftThisHour < 1) {
    throw new Error("No hourly submission capacity remains.");
  }
  if (!limits.data.dailyCapLeft || limits.data.dailyCapLeft < 1) {
    throw new Error("No daily submission capacity remains.");
  }
  if (!entry.data.canSubmit) throw new Error("Market is no longer eligible: " + (entry.data.reason ?? "unknown reason"));

  const note = candidate.claim + "\n\nResolution relevance and limitation: " + candidate.resolutionMapping;
  const idempotencyKey = createHash("sha256").update("sentinel-prime|" + APPROVED_ID).digest("hex");
  await mkdir(REPORT_DIR, { recursive: true });

  // Avoid a second logical entry if the same source/note was already recorded for this agent.
  const prior = await client.listSubmissions({ market: MARKET, agentId: "sentinel-prime", limit: 50 });
  const existing = prior.data.items.find(x =>
    x.agentId === "sentinel-prime" && x.links.includes(candidate.sourceUrl) && x.note === note
  );
  if (existing) {
    const receipt = { mode: "existing-submission-confirmed", submission: existing, checkedAt: new Date().toISOString(), idempotencyKey };
    await writeFile(join(REPORT_DIR, "submission-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log("Existing matching Delphi submission found: " + existing.id + " (" + existing.status + ")");
    return;
  }

  const initial = await client.submitEvidence({
    note, links: [candidate.sourceUrl], marketAddress: MARKET, idempotencyKey,
  });
  const firstReceipt = {
    mode: "submitted",
    submission: initial.data,
    requestId: initial.meta.requestId ?? null,
    checkedAt: new Date().toISOString(),
    idempotencyKey,
  };
  await writeFile(join(REPORT_DIR, "submission-receipt.json"), JSON.stringify(firstReceipt, null, 2) + "\n");
  console.log("Delphi accepted submission request: " + initial.data.id + " (" + initial.data.status + ")");

  const final = ["judged", "rejected", "failed", "unmatched"].includes(initial.data.status)
    ? initial.data
    : (await client.waitForSubmission(initial.data.id, { timeoutMs: 300_000, defaultIntervalMs: 2_000 })).data;
  const receipt = {
    mode: "submission-confirmed",
    submission: final,
    requestId: initial.meta.requestId ?? null,
    checkedAt: new Date().toISOString(),
    idempotencyKey,
  };
  await writeFile(join(REPORT_DIR, "submission-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log("Delphi submission " + final.id + " finished with status " + final.status);
  console.log(JSON.stringify(final.markets));
  if (final.status === "failed" || final.status === "unmatched") process.exitCode = 1;
}

main().catch(error => {
  console.error("Evidence submission failed:", error instanceof Error ? error.message : "Unknown error");
  process.exit(1);
});
