# PHASE 7 — OKX verification

Status: IN PROGRESS; READY FOR PHASE 8 is not set. Baseline `b7f934c930b55c066bcfbe6ccb20453206b9225f`, clean main/origin identical; [baseline CI 37188771838](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37188771838) SUCCESS all three jobs. Full local baseline before edits: format/docs/lint/typecheck/unit/HTTP/build/schema/runtime/clean/audit exit 0; 1825 unit, 41 HTTP, five production deployments, zero vulnerabilities. Artifacts: ignored `test-results/phase7-baseline-*`.

Scope: [requirements](requirements.md). No real private exchange calls or mutations are authorized; LIVE mutations remain disabled. Results/reproductions and exact final CI are added only after execution. PHASE 8 has not started.

## Local implementation and regression

2026-10-04: standalone OKX adapter implemented within [contracts](contracts.md), preserving previous phase code and published migrations. Full local checks completed by 09:27:06 UTC: format:check, docs:check, lint, typecheck, test:unit, test:http, build, db:validate, test:runtime, test:clean, pnpm audit --json — every exit code 0. Unit: **1987 passed, 0 failed, 0 skipped** (1825 baseline + **162 OKX**); HTTP: **41 passed**, no failure/skip. Six isolated production deployments PASS; lockfile SHA256 `537d6723736354db25afc867bd2dec4e4031aceaba8b7031c0bcc5602eb9a11d`. Audit: **0 info/low/moderate/high/critical**, 407 total dependencies; no old package version or integrity entry changed.

Actual public-only probe on the final local build: **24/24 PASS**, four immutable Spot/SWAP LIVE/DEMO profiles, native server time, instruments, ticker, book, three one-minute candles per profile and actual WS ticker DATA. At most 12 reservations, one connection and two controls per profile; no private requests, mutations, retries or alternative hosts. Exact UTC timestamps are in ignored `test-results/phase7-okx-public-probe.json`.

Private protocol is verified by scoped fixtures and actual loopback HTTP/WS, not an exchange account. Tests prove all 16 hung HTTP/Core pending slots remain BUSY until abort/actual socket closure, then a fresh private read succeeds; deadline/hung WS ACKs have bounded settlement; a lost POST response is UNKNOWN and a client-ID read finds the order with exactly one POST. Real private acceptance is **NOT RUN**. LIVE trading remains disabled.

## Reproduction → fix → regression

1. Contract tests were created before the missing native modules/client/assembly were implemented. Their initial failures establish development contracts, not defects in completed phases. Artifacts: phase7-contract-before, client-before/after, public-before/after, adapter-before and streams-before.
2. Observation regressions: missing native ticker ts falsely became local time; foreign instType was accepted. **2 RED → GREEN**: native timestamp is required and instrument type must match exact scope. Additional tests cover volume units, inconsistent fills/status/time, wallet liability and conflicting book sequences. Artifacts: phase7-observation-before and subsequent full OKX reports.
3. Actual Demo Spot instruments: blank maxMktSz caused metadata normalization failure. Native public JSON captured in the committed fixture. **2 RED → GREEN**: public metadata remains readable with an additional local BASE quantity cap and explicit unsupported new-risk admission. Actual extra fields remain unproved; no automatic whitelist/admission bypass. The first probe misclassified this successful-HTTP normalization failure as network unavailability; diagnostic HTTP 200 and native fixture identified the cause, and probe classification was corrected. Latest probe is 24/24 PASS. Artifacts: phase7-native-metadata-before/after and the fixture.
4. Known scalar/list metadata fields accepted unknown nested constraint shapes. **4 RED → GREEN**: explicit field shapes and list members now mark new constraints unsupported. Artifacts: phase7-filter-shapes-before/after.
5. Private cursor regression tests retain 16 live continuations, refuse BUSY overflow without eviction, consume final empty pages, then create 16 fresh continuations; single-consumer, pending-initial capacity race and query-binding tests PASS. Terminal cursors are deleted immediately, never held until TTL. Native ordinary/algo separation and complete Risk/Demo authorization remain required.

The existing full CI is pending on the source commit. READY FOR PHASE 8 has not been granted; source SHA, run and service/Docker evidence will be added only after execution.
