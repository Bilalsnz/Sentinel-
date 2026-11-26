# Sentinel Prime — expanded market watch (26 November 2026)

This note records a fresh pass over the current official Delphi market feed and primary-source research. It is not a candidate submission.

## Research coverage changes

- Source collector expanded from 12 to 18 eligible open markets.
- Per-run archive capacity increased from 24 to 36 sources.
- Selection still requires open status, at least two hours before evidence cutoff, 20–80% YES odds, and Delphi entry eligibility.
- Strict novelty floors remain market-specific and must be checked per candidate.
- No submission endpoint invoked.

## Strongest active research leads

### 1. BLS November payrolls — continue monitoring

Market: `0x6d14f2291c886a3469e988a7f80d307802a40c0a`

- ADP's Nov 24 NER Pulse was archived with SHA-256 and release time 2026-11-24T13:15:00Z, after the market's 2026-11-24T09:10:01.801Z novelty boundary.
- ADP reports a four-week average of 21,000 private-sector jobs per week through Nov 7. This is not BLS total nonfarm payrolls and does not directly resolve the +90,000 threshold.
- DOL weekly claims PDF for Nov 25 is archived, but the collector does not yet extract PDF publication time; keep it out of candidate staging until independently timestamp-verified.
- Continue searching for later ADP weekly pulse, official BLS leading indicators, and other post-boundary sources. Keep BLS first-print NFP as the sole resolving metric.

### 2. Swiss War Materiel Act — close but current polling is stale

Market: `0x191257a08df3a827a9a02fa54926ed9507b4497a`

- Latest GFS Bern/SRG poll published Nov 18 reports 49% Yes, 46% No, 5% undecided; survey fieldwork Nov 4–11. It predates the strict novelty boundary 2026-11-24T09:17:34.020Z.
- Swissinfo and Le Temps reporting the poll is also dated Nov 18; not novel.
- The vote is Nov 29. Wait for official result confirmation after the novelty floor; do not submit old polls.

### 3. Swiss turnout — no qualifying post-boundary survey found

Market: `0x94dbba7c9b44b788a701602ab6d919ff7b7fc38a`

- GFS Bern's 52% turnout intention estimate is from the Nov 18 poll and predates the market's strict novelty boundary (2026-11-24T09:06:27.769Z).
- Official vote is Nov 29. Only the Federal Chancellery's official turnout figure within the resolution window can settle the market.
- No candidate.

### 4. FIDE World Championship — useful official live-state monitoring

Market: `0x42fdc3fb099766fd01289f215cd399146e1f224e`

- Official FIDE match site reported the score level at 1–1 after two games on Nov 26; Games 1 and 2 were draws.
- Official Games page lists Game 8 for Dec 3 at 15:00 CET (14:00 UTC). Market evidence cutoff is Dec 2 13:00 UTC, before Game 8. The result of Game 8 itself cannot be pre-submitted as evidence before cutoff; maintain a monitoring-only posture.
- Official sources: https://worldchampionship.fide.com/ and https://worldchampionship.fide.com/games
- No candidate.

### 5. China November PPI — current baseline below threshold

Market: `0x71917b135a4702a3ae7276acbb2c42509e72ea8c`

- NBS official October 2026 PPI release (Nov 10) reports +5.7% YoY and +0.7% MoM; market threshold for November is 6.0% YoY.
- October release predates the strict novelty boundary (2026-11-24T09:14:48.225Z), so it is baseline context only.
- Search for post-boundary commodity/industrial price indicators, but do not represent them as the November NBS PPI figure.

### 6. Japan GDP — settlement timing warning

Market: `0x55224cfb33522244ac64f969e5a38a5d4413fc23`

- Official ESRI schedule lists the second preliminary Jul–Sep 2026 GDP release at 08:50 JST on Dec 8 (2026-12-07T23:50Z).
- Market's resolution upper bound is 2026-12-07T20:00Z, three hours and fifty minutes earlier than the scheduled release. Under the stated criteria, the official figure is not scheduled to be available inside the settlement window; this market may be unresolvable unless ESRI publishes early. Flag for caution and do not prioritize candidate submissions.

### 7. Valencia Marathon — elite field context is pre-boundary

Market: `0x20dee82eb91956386496658e86ce5696edd09b25`

- Official race entry list published Nov 17 lists Kenenisa Bekele (PB 2:01:41), John Korir (2:02:24), and Birhanu Legese (2:02:48), among others.
- Entry list predates strict novelty boundary 2026-11-24T09:52:47Z; useful baseline only, not eligible evidence.
- Seek post-boundary official withdrawals, weather, course, or elite-field updates. Do not infer the eventual winning time from personal bests.

### 8. ARC-AGI-3 final leaderboard

Market: `0xa96dc716066329d666f3c50e6d8f71c701347296`

- Official ARC Prize page says competition is closed and results will be announced Dec 4.
- Public leaderboard is not the final private leaderboard specified by the resolver. Public rank snapshots cannot establish the settlement outcome.
- Monitor official announcement and final private leaderboard only; no candidate.

## Current disposition

- BLS ADP report: archived, post-boundary, contextual indicator; not yet eligible as a strong direct candidate.
- Korean budget: committee activity only; no proof of plenary passage.
- Swiss polls: last available poll predates novelty floors.
- FIDE, China PPI, Valencia, ARC: monitor, no candidate.
- Japan GDP: flag possible resolution-window mismatch.
- Evidence submitted: **0**.
- Human authorization for any submission: **not given**.

## Sources checked

- GFS Bern, Nov 18 SRG poll: https://www.gfsbern.ch/en/news/2-srg-trendumfrage-zur-eidg-abstimmung-vom-29-november-2026/
- Swissinfo, Nov 18: https://www.swissinfo.ch/eng/votes/november-29-votes-opposition-to-pension-financing-plan-edging-ahead/92396495
- FIDE official site and games: https://worldchampionship.fide.com/ ; https://worldchampionship.fide.com/games
- NBS October PPI: https://www.stats.gov.cn/english/PressRelease/202611/t20261111_1965806.html
- ESRI GDP release schedule: https://www.esri.cao.go.jp/en/sna/kouhyou/kouhyou_top.html
- Valencia official elite entry list: https://www.valenciaciudaddelrunning.com/en/listado-atletas-entry-list-del-maraton-valencia-2026/
- ARC Prize official page: https://arcprize.org/competitions/2026
