# Market scan — Stage 1

Run with `npm install` and `npm run market:scan`.

Optional environment variables:
- `COMPETITION_MARKETS_URL`: override the official markets JSON URL.
- `REPORT_DIR`: output directory (default: `reports`).

The scanner validates the public market feed, hashes the exact response, ranks open markets for research triage and writes JSON/Markdown reports.

It deliberately does not call the authenticated Delphi API, check account entry state, discover or verify evidence, or submit anything. Its score is an operational queue heuristic, not a forecast, evidence-quality score, novelty score or expected-value estimate.

A timestamp parsed from resolution criteria is not assumed to be the forecaster-view timestamp. That must be verified independently before novelty decisions.

Future submission code must be separate, human-approved and disabled by default.
