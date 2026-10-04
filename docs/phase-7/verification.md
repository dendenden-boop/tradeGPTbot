# PHASE 7 — OKX verification

Gate: **WITHHELD pending metadata-lifetime hardening acceptance**. The first source [`e022b60c24e1ca7bb2ae065a0844b973152bb92f`](https://github.com/dendenden-boop/tradeGPTbot/commit/e022b60c24e1ca7bb2ae065a0844b973152bb92f) passed all three jobs of [CI 37192370532](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37192370532), completed **2026-10-04 09:39:30 UTC**. A subsequent cross-component audit reproduced stale contract interpretation in asynchronous market data; the former gate is superseded until the correction passes full regression/CI. PHASE 8 has not started.

Baseline `b7f934c930b55c066bcfbe6ccb20453206b9225f`, clean main/origin identical; [baseline CI 37188771838](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37188771838) SUCCESS all three jobs. Full local baseline before edits: format/docs/lint/typecheck/unit/HTTP/build/schema/runtime/clean/audit exit 0; 1825 unit, 41 HTTP, five production deployments, zero vulnerabilities. Artifacts: ignored `test-results/phase7-baseline-*`.

No real private exchange calls or mutations are authorized; LIVE mutations remain disabled. Public exchange results and private fixtures/loopback are distinguished below. Unproved native constraints continue to block new-risk dispatch.

## Local implementation and regression

2026-10-04: standalone OKX adapter implemented within [contracts](contracts.md), preserving previous phase code and published migrations. Full local checks completed: format:check, docs:check, lint, typecheck, test:unit, test:http, build, db:validate, test:runtime, test:clean, pnpm audit --json — every exit code 0. Unit: **1987 passed, 0 failed, 0 skipped** (1825 baseline + **162 OKX**); HTTP: **41 passed**, no failure/skip. Six isolated production deployments PASS; lockfile SHA256 `537d6723736354db25afc867bd2dec4e4031aceaba8b7031c0bcc5602eb9a11d`. Audit: **0 info/low/moderate/high/critical**, 407 total dependencies; no old package version or integrity entry changed.

Actual public-only probe on the final local build: **24/24 PASS**, four immutable Spot/SWAP LIVE/DEMO profiles, native server time, instruments, ticker, book, three one-minute candles per profile and actual WS ticker DATA. At most 12 reservations, one connection and two controls per profile; no private requests, mutations, retries or alternative hosts. Exact UTC timestamps are in ignored `test-results/phase7-okx-public-probe.json`.

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
| Unit / HTTP per OS                                | 1987 / 41 passed; 0 failed or skipped; OKX contributes 162 distinct tests                                                                                          |
| Real PostgreSQL/Redis dependency lifecycle        | 3 passed; outages and recovery exercised                                                                                                                           |
| Database/security/ownership/query-plan regression | 199 passed; 0 failures/skips                                                                                                                                       |
| Service reports                                   | integration/database/auth-database-hardening/auth-hardening-load PASS; 100 users/sessions load exercised                                                           |
| Docker API/SMTP/dependency lifecycle and shutdown | smoke PASS; actual shutdown 320ms                                                                                                                                  |
| Production packaging                              | 6 isolated deployments PASS on each OS; exact lockfile SHA256 matches local result                                                                                 |
| Dependency audit                                  | Both CI audit steps print No known vulnerabilities found; local full JSON is zero at every severity                                                                |

Total: **2230 distinct tests = 1987 unit + 41 HTTP + 199 database + 3 dependency lifecycle**. The same suite on two operating systems is not counted twice. Native public probe: 24/24 PASS on the final local build, **2026-10-04 09:27:24–09:27:37 UTC**. This probe is separate from offline CI, not represented as a CI network test. Artifacts are ignored local evidence in `test-results/phase7-ci-source/`, source-CI JSON/log and phase7-final reports.

Cross-phase preservation is verified by identical baseline/source trees: Core `a2530842aad20afd90215679e7bf35ac9c11c848`, Binance `bdfeeede50386294fac6b0ecf6bed175df6ed9b3`, Bybit `00d9b06f263e29411c066715ebb44edff3c44f1a`, published migrations `7d846113c5801472e8b8a03cf4da034a55cb090e`. Application/database sources are unchanged. New OKX source/package/test tree: `2466f03693e865a715f8ca10f74e2b32d0604bc9`. Only a workspace importer is added to the lockfile.

Limits remain explicit: actual private exchange acceptance NOT RUN; live trading disabled; unknown Demo metadata constraints fail closed; 300-instrument load, durable trading services, automatic reconnect/backfill and later phases are not claimed. The first source CI remains historical evidence; the correction requires its own complete acceptance.

## Cross-component metadata-lifetime correction

Three tests reproduced the issue before changes: metadata expires during a REST book request; WS data arrives after metadata expiry; the registry replaces contract version/ctVal while a WS source holds its old immutable record. All three incorrectly emitted readable/fresh data, including old CONTRACTS→BASE conversion. Artifact phase7-metadata-lifetime-before: **3 failed**.

Fix: recheck the active registry/cache version and expiry before REST normalization and each WS frame; bound WS lifetime by metadata expiry and emit resync when expiry/version differs. Source closes and releases timers/resources. Artifact phase7-metadata-lifetime-after: **165 OKX tests PASS**, including **3 RED → GREEN** metadata-lifetime regressions. No completed phase or published migration was changed.

Correction local acceptance on 2026-10-04: format/docs/lint/typecheck/unit/HTTP/build/schema/runtime/clean/audit all exit 0; **1990 unit + 41 HTTP passed, zero failures/skips**, six clean deployments with unchanged lockfile SHA256, zero audit vulnerabilities at every severity (407 dependencies). The corrected build also passed **24/24 public-only REST/WS probes** across all four profiles. Evidence: ignored phase7-hardening checks, audit, unit, HTTP, clean and public-probe reports. Full CI for this correction is pending; the gate remains withheld.
