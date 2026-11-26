# Sentinel Prime research note — US November 2026 payrolls

**Last reviewed:** 2026-11-26 UTC  
**Market:** `0x6d14f2291c886a3469e988a7f80d307802a40c0a`  
**Question:** Will the BLS Employment Situation for Nov 2026 (Dec 4) report a first-print NFP change of +90,000 or more?  
**Evidence cutoff:** 2026-12-03T12:30:00Z  
**Strict novelty boundary:** 2026-11-24T09:10:01.801Z  
**Current status:** Open. Research lead identified; candidate pending archived-source verification. No evidence submitted.

## Fresh post-boundary indicators

1. **ADP NER Pulse, Nov 24, 2026** — ADP reports that private employers added an average of 21,000 jobs per week over the four weeks ending Nov 7. The same release says the estimate is preliminary and may change. ADP states that the NER Pulse publishes every Tuesday at 8:15 a.m. ET; because Nov 24, 2026 was Tuesday, the scheduled release time is 13:15 UTC, after the market's 09:10:01.801 UTC novelty boundary.
   - Official release: https://mediacenter.adp.com/2026-11-24-ADP-National-Employment-Report-Preliminary-Estimate-for-November-7,-2026
   - Source facts: four-week average 21,000; prior week-ending averages 23,000 (Oct 31) and 19,250 (Oct 24); preliminary/private-sector measure, not the BLS total nonfarm payroll series.
2. **U.S. Department of Labor, Nov 25, 2026** — The weekly unemployment-insurance release reports 189,000 initial claims for the week ending Nov 21, down 13,000 from the prior week's revised level, and 1.697 million insured unemployment for the week ending Nov 14, down 95,000. The PDF states an embargo lift of 8:30 a.m. Eastern on Nov 25 (13:30 UTC).
   - Official release: https://oui.doleta.gov/press/2026/112526.pdf
3. **BLS official schedule** — The November 2026 Employment Situation is scheduled for Dec 4, 2026 at 8:30 a.m. Eastern.
   - Official BLS page: https://www.bls.gov/ces/

## Candidate decision

These are relevant leading indicators, but neither is the resolving BLS first-print total nonfarm payroll figure. ADP is a private-sector, four-week estimate with a two-week lag; initial claims measure layoffs, not payroll growth. Keep them as context and do not claim they prove the +90,000 threshold. The ADP release is the strongest research candidate because its dated release schedule places publication after the strict novelty boundary.

**Do not submit yet.** The source must first be archived by Sentinel Prime with a matching SHA-256 and publication timestamp, and a human must review the archived source and confirm its resolution relevance. No market position or submission is authorized.

## Next verification

- Confirm the ADP HTML page is present in the source-snapshot artifact and its publication timestamp is extracted as 2026-11-24T13:15:00.000Z.
- Confirm the DOL PDF archive hash and preserve its embargo timestamp separately; the current validator does not infer PDF publication timestamps.
- Compare any newer ADP Pulse and weekly claims releases against the same novelty boundary and the Dec 3 evidence cutoff.
- Keep the BLS Nov 6 October payroll release as pre-boundary baseline only; it is not novel evidence for this market.

## Safety and audit

- This note is research context, not a staged evidence candidate.
- No evidence submitted and no submit endpoint invoked.
- The final resolving metric remains BLS first-print total nonfarm payroll change.
