import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";

const BASE = "https://delphi.fyi/v1";
const REPORT_DIR = process.env.REPORT_DIR || "reports";
const CANDIDATES_FILE = process.env.CANDIDATES_FILE || "candidate-staging.json";
type Candidate = {
  id: string; marketAddress: string; claim: string; sourceUrl: string;
  resolutionMapping: string; humanVerified?: boolean; verificationNote?: string; corroboratingUrls?: string[];
};
type Validation = {
  generatedAt: string; terms: { version: string; acceptedAt: string | null };
  candidates: { id: string; marketAddress: string; passed: boolean; gates: { name: string; passed: boolean }[] }[];
};

async function waitBriefly(client: EvidenceClient, id: string, initial: Awaited<ReturnType<EvidenceClient["getSubmission"]>>) {
  let current = initial;
  const deadline = Date.now() + 90_000;
  const terminal = new Set(["judged", "rejected", "failed", "unmatched"]);
  while (!terminal.has(current.data.status) && Date.now() < deadline) {
    const delay = Math.min((current.meta.retryAfterSeconds ?? 5) * 1000, 15_000);
    if (Date.now() + delay > deadline) break;
    await new Promise(resolve => setTimeout(resolve, delay));
    current = await client.getSubmission(id);
  }
  return { result: current, terminal: terminal.has(current.data.status) };
}

async function main() {
  const key = process.env.DELPHI_API_ACCESS_KEY;
  if (!key) throw new Error("DELPHI_API_ACCESS_KEY missing");
  if (process.env.SENTINEL_AUTONOMOUS_SUBMISSION_AUTHORIZED !== "true") {
    throw new Error("Standing owner authorization flag missing; refusing autonomous submission.");
  }
  const report = JSON.parse(await readFile(join(REPORT_DIR, "candidate-validation.json"), "utf8")) as Validation;
  const age = Date.now() - Date.parse(report.generatedAt);
  if (!Number.isFinite(age) || age < 0 || age > 10 * 60_000) throw new Error("Validation report is stale; refusing submission.");
  const candidates = JSON.parse(await readFile(CANDIDATES_FILE, "utf8")) as Candidate[];
  if (!Array.isArray(candidates)) throw new Error("Candidate staging file must contain an array.");

  const client = new EvidenceClient({
    baseUrl: BASE, apiKey: key, agentId: "sentinel-prime",
    agentHarness: "Bilalsnz/Sentinel-", agentModel: "sentinel-prime-autonomous-evidence-agent",
  });
  const terms = await client.getTerms();
  if (!terms.data.acceptedAt || terms.data.version !== report.terms.version) {
    throw new Error("Current Delphi terms are not the already-accepted version; refusing submission.");
  }
  const receipts: unknown[] = [];
  await mkdir(REPORT_DIR, { recursive: true });

  for (const checked of report.candidates) {
    if (!checked.passed || checked.gates.some(g => !g.passed)) continue;
    const candidate = candidates.find(c => c.id === checked.id);
    if (!candidate || candidate.marketAddress.toLowerCase() !== checked.marketAddress.toLowerCase()) {
      console.error("Skip " + checked.id + ": staged candidate does not match validation report.");
      continue;
    }
    if (!candidate.claim?.trim() || !candidate.resolutionMapping?.trim() || !candidate.sourceUrl?.startsWith("https://")) {
      console.error("Skip " + checked.id + ": missing claim, resolution mapping, or HTTPS source.");
      continue;
    }

    const limits = await client.getLimits();
    if ((limits.data.submitsLeftThisHour ?? 0) < 1 || (limits.data.dailyCapLeft ?? 0) < 1) {
      console.log("Stopping: Delphi hourly or daily submission capacity exhausted.");
      break;
    }
    const entry = await client.getEntryState(candidate.marketAddress);
    if (!entry.data.canSubmit) {
      console.log("Skip " + checked.id + ": market is not currently eligible (" + (entry.data.reason ?? "unknown") + ").");
      continue;
    }

    const note = candidate.claim + "\\n\\nResolution relevance and limitation: " + candidate.resolutionMapping;
    const idempotencyKey = createHash("sha256").update("sentinel-prime|" + candidate.marketAddress.toLowerCase() + "|" + candidate.id).digest("hex");
    const prior = await client.listSubmissions({ market: candidate.marketAddress, agentId: "sentinel-prime", limit: 50 });
    const existing = prior.data.items.find(x =>
      x.agentId === "sentinel-prime" && x.links.includes(candidate.sourceUrl)
    );
    if (existing) {
      const latest = await client.getSubmission(existing.id);
      const checkedExisting = await waitBriefly(client, existing.id, latest);
      receipts.push({
        mode: checkedExisting.terminal ? "existing-final" : "existing-pending",
        candidateId: candidate.id, submission: checkedExisting.result.data,
        requestId: checkedExisting.result.meta.requestId ?? null, idempotencyKey,
      });
      console.log("Existing submission " + existing.id + ": " + checkedExisting.result.data.status);
      continue;
    }

    const initial = await client.submitEvidence({
      note, links: [...new Set([candidate.sourceUrl, ...(candidate.corroboratingUrls ?? [])])], marketAddress: candidate.marketAddress, idempotencyKey,
    });
    console.log("Delphi accepted " + candidate.id + ": " + initial.data.id + " (" + initial.data.status + ")");
    const polled = await waitBriefly(client, initial.data.id, initial);
    receipts.push({
      mode: polled.terminal ? "submitted-final" : "submitted-pending",
      candidateId: candidate.id, submission: polled.result.data,
      requestId: polled.result.meta.requestId ?? initial.meta.requestId ?? null, idempotencyKey,
    });
    await writeFile(join(REPORT_DIR, "submission-receipt.json"), JSON.stringify({
      agent: "sentinel-prime", authorization: "standing owner authorization",
      checkedAt: new Date().toISOString(), receipts,
    }, null, 2) + "\\n");
  }

  const finalReceipt = {
    agent: "sentinel-prime", authorization: "standing owner authorization",
    checkedAt: new Date().toISOString(), attemptedCandidates: receipts.length, receipts,
  };
  await writeFile(join(REPORT_DIR, "submission-receipt.json"), JSON.stringify(finalReceipt, null, 2) + "\\n");
  console.log("Autonomous submission cycle complete. Receipts recorded: " + receipts.length);
}
main().catch(error => {
  console.error("Autonomous evidence submission failed:", error instanceof Error ? error.message : "Unknown error");
  process.exit(1);
});
