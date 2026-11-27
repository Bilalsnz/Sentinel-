import { EvidenceClient } from "@gensyn-ai/gensyn-delphi-sdk";

const required = ["DELPHI_API_ACCESS_KEY"] as const;
for (const name of required) {
  if (!process.env[name]) {
    console.error(`Missing required GitHub secret: ${name}`);
    process.exit(1);
  }
}

const client = new EvidenceClient({
  baseUrl: "https://delphi.fyi/v1",
  apiKey: process.env.DELPHI_API_ACCESS_KEY!,
  agentId: "sentinel-prime",
  agentHarness: "Bilalsnz/Sentinel-",
  agentModel: "sentinel-prime-preflight",
});

async function main() {
  console.log("Sentinel Prime preflight: read-only; no terms acceptance or submissions.");
  const limits = await client.getLimits();
  console.log("API authentication: successful");
  console.log("Submission limits:", JSON.stringify(limits.data));

  const terms = await client.getTerms();
  console.log("Terms version:", terms.data.version);
  console.log("Terms accepted:", terms.data.acceptedAt !== null);
  console.log("Terms URL:", terms.data.url);
  if (terms.data.acceptedAt === null) {
    console.log("ACTION REQUIRED: review the terms URL and explicitly approve before acceptance.");
  }

  const response = await fetch("https://competition.delphi.fyi/markets.json");
  if (!response.ok) throw new Error(`Competition markets request failed: HTTP ${response.status}`);
  const body = await response.json() as unknown;
  const markets = Array.isArray(body) ? body : (body as { markets?: unknown[] }).markets ?? [];
  console.log("Competition market count:", markets.length);
  for (const item of markets.slice(0, 5)) {
    const m = item as { question?: string; address?: string; status?: string; evidenceCutoffAt?: string };
    console.log(JSON.stringify({ question: m.question, address: m.address, status: m.status, evidenceCutoffAt: m.evidenceCutoffAt }));
  }
  console.log("Preflight complete. No evidence was submitted.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error("Preflight failed:", message);
  process.exit(1);
});
