# PHASE 7 — OKX verification

Current gate: **NOT READY FOR PHASE 8** pending [cross-adapter InstrumentRegistry lifecycle acceptance](../instrument-registry-lifecycle.md). PHASE 8 has not started. The results below are the historical OKX acceptance before this newly reproduced defect.

Historical gate: **READY FOR PHASE 8**. Accepted source [`ff7db4290e56e870049ac2697b9b8d470b71fc8e`](https://github.com/dendenden-boop/tradeGPTbot/commit/ff7db4290e56e870049ac2697b9b8d470b71fc8e) passed all three jobs of [CI 37194114436](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37194114436), completed **2026-10-04 10:12:08 UTC**. Downloaded Ubuntu, Windows and Docker artifacts verify the corrected metadata lifetime and full regression below.

Historical first source `e022b60c24e1ca7bb2ae065a0844b973152bb92f` passed [CI 37192370532](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37192370532) at 09:39:30 UTC. A subsequent cross-component audit reproduced stale contract interpretation in asynchronous market data, withholding the former gate. Three reproduction tests preceded the correction; the accepted source and CI above supersede that earlier acceptance.

Baseline `b7f934c930b55c066bcfbe6ccb20453206b9225f`, clean main/origin identical; [baseline CI 37188771838](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37188771838) SUCCESS all three jobs. Full local baseline before edits: format/docs/lint/typecheck/unit/HTTP/build/schema/runtime/clean/audit exit 0; 1825 unit, 41 HTTP, five production deployments, zero vulnerabilities. Artifacts: ignored `test-results/phase7-baseline-*`.

No real private exchange calls or mutations are authorized; LIVE mutations remain disabled. Public exchange results and private fixtures/loopback are distinguished below. Unproved native constraints continue to block new-risk dispatch.

## Local implementation and regression

2026-10-04: standalone OKX adapter implemented within [contracts](contracts.md), preserving previous phase code and published migrations. Full local checks repeated after metadata-lifetime correction: format:check, docs:check, lint, typecheck, test:unit, test:http, build, db:validate, test:runtime, test:clean, pnpm audit --json — every exit code 0. Unit: **1990 passed, 0 failed, 0 skipped** (1825 baseline + **165 OKX**); HTTP: **41 passed**, no failure/skip. Six isolated production deployments PASS; lockfile SHA256 `537d6723736354db25afc867bd2dec4e4031aceaba8b7031c0bcc5602eb9a11d`. Audit: **0 info/low/moderate/high/critical**, 407 total dependencies; no old package version or integrity entry changed.

Actual public-only probe on the corrected local build: **24/24 PASS**, four immutable Spot/SWAP LIVE/DEMO profiles, native server time, instruments, ticker, book, three one-minute candles per profile and actual WS ticker DATA. At most 12 reservations, one connection and two controls per profile; no private requests, mutations, retries or alternative hosts. Exact UTC timestamps are in ignored `test-results/phase7-hardening-public-probe.json`.

Private protocol is verified by scoped fixtures and actual loopback HTTP/WS, not an exchange account. Tests prove all 16 hung HTTP/Core pending slots remain BUSY until abort/actual socket closure, then a fresh private read succeeds; deadline/hung WS ACKs have bounded settlement; a lost POST response is UNKNOWN and a client-ID read finds the order with exactly one POST. Real private acceptance is **NOT RUN**. LIVE trading remains disabled.

## Reproduction → fix → regression

1. Contract tests were created before the missing native modules/client/assembly were implemented. Their initial failures establish development contracts, not defects in completed phases. Artifacts: phase7-contract-before, client-before/after, public-before/after, adapter-before and streams-before.
2. Observation regressions: missing native ticker ts falsely became local time; foreign instType was accepted. **2 RED → GREEN**: native timestamp is required and instrument type must match exact scope. Additional tests cover volume units, inconsistent fills/status/time, wallet liability and conflicting book sequences. Artifacts: phase7-observation-before and subsequent full OKX reports.
3. Actual Demo Spot instruments: blank maxMktSz caused metadata normalization failure. Native public JSON captured in the committed fixture. **2 RED → GREEN**: public metadata remains readable with an additional local BASE quantity cap and explicit unsupported new-risk admission. Actual extra fields remain unproved; no automatic whitelist/admission bypass. The first probe misclassified this successful-HTTP normalization failure as network unavailability; diagnostic HTTP 200 and native fixture identified the cause, and probe classification was corrected. Latest probe is 24/24 PASS. Artifacts: phase7-native-metadata-before/after and the fixture.
4. Known scalar/list metadata fields accepted unknown nested constraint shapes. **4 RED → GREEN**: explicit field shapes and list members now mark new constraints unsupported. Artifacts: phase7-filter-shapes-before/after.
5. Private cursor regression tests retain 16 live continuations, refuse BUSY overflow without eviction, consume final empty pages, then create 16 fresh continuations; single-consumer, pending-initial capacity race and query-binding tests PASS. Terminal cursors are deleted immediately, never held until TTL. Native ordinary/algo separation and complete Risk/Demo authorization remain required.

## Full source CI acceptance

Downloaded and inspected all three artifacts (`bootstrap-ubuntu-24.04`, `bootstrap-windows-2025`, `bootstrap-docker`) from the exact source run:

| Evidence                                          | Actual result                                                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ubuntu 24.04 / Windows 2025                       | Both jobs SUCCESS; pinned Node v24.20.0, pnpm 11.25.0, format/docs/lint/typecheck/build/schema/benchmark/unit/HTTP/runtime/clean/audit/frozen lockfile checks PASS |
| Unit / HTTP per OS                                | 1990 / 41 passed; 0 failed or skipped; OKX contributes 165 distinct tests                                                                                          |
| Real PostgreSQL/Redis dependency lifecycle        | 3 passed; outages and recovery exercised                                                                                                                           |
| Database/security/ownership/query-plan regression | 199 passed; 0 failures/skips                                                                                                                                       |
| Service reports                                   | integration/database/auth-database-hardening/auth-hardening-load PASS; 100 users/sessions load exercised                                                           |
| Docker API/SMTP/dependency lifecycle and shutdown | smoke PASS; actual shutdown 308ms                                                                                                                                  |
| Production packaging                              | 6 isolated deployments PASS on each OS; exact lockfile SHA256 matches local result                                                                                 |
| Dependency audit                                  | Both CI audit steps print No known vulnerabilities found; local full JSON is zero at every severity                                                                |

Total: **2233 distinct tests = 1990 unit + 41 HTTP + 199 database + 3 dependency lifecycle**. The same suite on two operating systems is not counted twice. Native public probe: 24/24 PASS on the corrected local build, **2026-10-04 10:02:10–10:02:24 UTC**. This probe is separate from offline CI, not represented as a CI network test. Artifacts are ignored local evidence in `test-results/phase7-ci-hardening/`, phase7-hardening CI JSON/log, local checks and reports. The downloaded run records the exact accepted source SHA; no inference from a different revision is used.

Cross-phase preservation is verified by identical baseline/accepted-source trees: Core `a2530842aad20afd90215679e7bf35ac9c11c848`, Binance `bdfeeede50386294fac6b0ecf6bed175df6ed9b3`, Bybit `00d9b06f263e29411c066715ebb44edff3c44f1a`, published migrations `7d846113c5801472e8b8a03cf4da034a55cb090e`. Application/database sources are unchanged. Accepted OKX source/package/test tree: `3f079dc28a0b8efa622d8061d3ae30802c951865`. Only a workspace importer is added to the lockfile.

Limits remain explicit: actual private exchange acceptance NOT RUN; live trading disabled; unknown Demo metadata constraints fail closed; 300-instrument load, durable trading services, automatic reconnect/backfill and later phases are not claimed. This is adapter protocol acceptance, not production trading readiness.

## Cross-component metadata-lifetime correction

Three tests reproduced the issue before changes: metadata expires during a REST book request; WS data arrives after metadata expiry; the registry replaces contract version/ctVal while a WS source holds its old immutable record. All three incorrectly emitted readable/fresh data, including old CONTRACTS→BASE conversion. Artifact phase7-metadata-lifetime-before: **3 failed**.

Fix: recheck the active registry/cache version and expiry before REST normalization and each WS frame; bound WS lifetime by metadata expiry and emit resync when expiry/version differs. Source closes and releases timers/resources. Artifact phase7-metadata-lifetime-after: **165 OKX tests PASS**, including **3 RED → GREEN** metadata-lifetime regressions. No completed phase or published migration was changed.

Correction acceptance on 2026-10-04: full local regression and **all three jobs of CI 37194114436 SUCCESS**, with downloaded artifacts confirming **1990 unit + 41 HTTP + 199 database + 3 dependency tests**, zero failures/skips; six clean deployments with unchanged lockfile SHA256; zero local audit vulnerabilities at every severity (407 dependencies) and both CI audits clean. The corrected build passed **24/24 public-only REST/WS probes**. Evidence: ignored phase7-hardening reports and phase7-ci-hardening artifacts. The metadata-lifetime defect is fixed; **READY FOR PHASE 8** is restored after this complete acceptance.
