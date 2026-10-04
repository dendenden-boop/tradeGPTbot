# PHASE 9 verification

Gate: **READY FOR PHASE 10**. PHASE 9 implementation and full source acceptance are complete. PHASE 10 has not started.

Baseline main: `20523a4455d79c9f4ff77b2cccf6d53d1d6b250a`. Before phase source changes, format:check, docs:check, lint, typecheck, test:unit, test:http, build, db:validate, test:runtime and test:clean passed on 4 October 2026 (18:01–18:05 UTC). 2217 unit tests and 41 HTTP tests; seven clean deployments. Dependency audit has zero vulnerabilities at all severities (407 dependencies). Ignored evidence: phase9-baseline-checks.json, phase9-baseline-*.log and phase9-baseline-audit.json.

Previous full main CI [37221754608](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37221754608) passed all three jobs. Published migrations tree at baseline: `7d846113c5801472e8b8a03cf4da034a55cb090e`. No production load, LIVE trading, private acceptance or PHASE 10 implementation is claimed.

## RED and repairs

Initial candle/store/engine/pool/native/worker/snapshot tests were written before their modules. Missing-module runs are scaffolding RED, not regressions in PHASE 0–8. During implementation, executed RED tests captured three revision/connection-accounting failures (phase9-hardening-red.log), partial gap repair (phase9-worker.log), three late-history/snapshot failures (phase9-late-history-red.log), the USDM public-versus-market endpoint error (phase9-usdm-route-red.log) and three restart/multiplicity/checkpoint integrity failures (phase9-restart-integrity-red.log). All are in new PHASE 9 code; completed adapter private/order implementations were not changed.

Repairs preserve slots until physical settling, increment published partial revisions on correction, subtract only proven gap coverage, prevent resurrecting expired populated history as empty, keep watermark monotonic, clear malformed known-key snapshots, route USDM trades through the existing market endpoint, keep restored history stale until reconciliation, include execution multiplicity in dedup hashes and reject impossible persisted empty data. Loopback tests prove hung real HTTP upgrade/WS ACK deadline and abort terminate actual sockets. Native ACK/normalization tests cover Spot and linear profiles across Binance, Bybit, OKX and HTX, including gzip and exact large IDs.

After the initial source CI, a real server-PING regression reproduced an unmasked client PONG: **1 failed / 14 passed** in the native feed suite (phase9-pong-mask-red.log). The server did not receive the invalid response. The fix explicitly enables the client frame mask in `native-io.ts`. The regression checks that the real WS server receives the original heartbeat payload and keeps the connection open; all **61 PHASE 9 tests** then passed (phase9-pong-mask-green.log), with lint and typecheck exit 0. This transport correction requires a new full CI before acceptance.

## Local regression

Final local checks all exit 0 on 4 October 2026, 19:07–19:11 UTC: format:check, docs:check, lint, typecheck, test:unit, test:http, build, db:validate, test:runtime, test:clean and audit JSON. **2277 unit tests / 96 files**, including **60 PHASE 9 tests**, plus **41 HTTP**. Eight isolated clean deployments include market-data and all four compiled read-only adapter subpaths; raw IO/testing subpaths are excluded. Dependency audit: **0 vulnerabilities at all severities**, 407 dependencies. Lockfile SHA256 `3ba0855b831263fcb9325dd6ee4d24cbc41d17c5819c2c713f625604e6199186`; only workspace importers changed, pinned dependency versions remain unchanged. Existing published migrations unchanged; new market schema is additive. Evidence: ignored phase9-final-checks.json, phase9-final-*.log, phase9-final-audit.json, unit.json, http.json and clean-install.json.

After the PONG fix, the full local sequence above passed again on 4 October 2026, **19:39–19:44 UTC**: **2278 unit tests / 96 files**, **61 PHASE 9 tests**, **41 HTTP**, eight clean deployments and audit exit 0. Evidence: ignored phase9-pong-final-checks.json, phase9-pong-final-*.log and phase9-pong-final-audit.json. The subsequent documentation evidence update is checked separately before commit.

The load test uses **300 unique Binance Spot TESTNET keys**, **6000 native frames**, **three real loopback WS sockets** and **seven timeframes**, with zero dropped inputs. Its registry/store are explicitly test/reference models. JSON records hardware/runtime, duration, CPU/RSS, event-loop delay, latency, queue and state bytes. Initial synchronous draining showed a multi-second event-loop stall; bounded work/yield and asynchronous native delivery reduced it. Numbers vary with concurrent tests; CI artifacts retain their own measurements. This is neither a 6000 messages/s production certificate nor a 24h soak, and it does not benchmark 300 native order-book streams. Extended performance acceptance remains PHASE 20.

Docker CLI is not installed locally. The new PostgreSQL integration tests run in the existing isolated real-services CI runner, with a separate restricted ingest login; no local real-PostgreSQL result is claimed. Final source acceptance is recorded below.

## Initial source CI

[CI 37227648784](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37227648784) succeeded for `8b1f4b870bbaab4c8be5055b4bdb4bda77a71f67` on 4 October 2026 at 19:26:37 UTC. All three jobs passed. Downloaded artifacts were checked against the exact SHA: both Ubuntu and Windows passed 2277 unit tests (60 market-data, 215 HTX), 41 HTTP tests, eight clean deployments and runtime/audit checks. The Docker job passed 208 real database tests, including all nine new market-data tests, three dependency lifecycle tests, integration/auth/SMTP/Redis recovery and 46 authentication smoke requests. This is 2529 distinct tests across the suites; platform repeats are not added. Evidence: ignored phase9-source-ci.json/log, phase9-ci-source artifacts and phase9-source-artifacts-verified.json. This run predates the PONG regression and is not the final acceptance run.

## Final source acceptance

Accepted source: **`e3226a841dc873c3e934d330efca31f99bfeaf3a`**. Full [CI 37229487039](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37229487039) completed successfully on **4 October 2026, 19:55:50 UTC**, including the masked-PONG regression. All three jobs passed. Downloaded sanitized reports were checked against the exact source SHA at 19:57:26 UTC; no failed or skipped unit tests.

| Acceptance                                                | Actual result                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Ubuntu and Windows unit suites                            | 2278 passed on each OS, including 61 PHASE 9 and 215 HTX                              |
| HTTP suites                                               | 41 passed on each OS                                                                  |
| Real PostgreSQL                                           | 208 passed, including nine PHASE 9 integration tests                                  |
| Dependency lifecycle                                      | Three passed against real services                                                    |
| Clean deployment                                          | Eight isolated packages on each OS; frozen lockfile unchanged                         |
| Runtime / format / docs / lint / types / build / schema   | PASS                                                                                  |
| Dependency audit                                          | Both CI audits report no known vulnerabilities; local JSON has zero at all severities |
| Integration / auth / SMTP / Redis recovery / Docker smoke | PASS; 46 auth smoke requests; shutdown 371ms                                          |

**2530 distinct tests** = 2278 unit + 41 HTTP + 208 database + three dependency lifecycle. Platform repeats and smoke requests are not added to this count. The nine new real-PostgreSQL tests cover restricted role admission, atomic checkpoint/bar/outbox, restart fencing and replay, concurrent CAS, outbox rollback, physical query abort/deadline, checkpoint hash/financial permissions and conflicting candle revisions. Existing order/risk/auth tests and permanent registry version anti-reuse tests remain green. Previous published migrations are unchanged; only additive `202610040001_market_data` was introduced.

The 300-key loopback fixture passed on both OS: 6000 native frames, three physical WS connections, seven timeframes, zero drops and a drained queue. Maximum queue: 6000 items / 2,306,160 bytes; final candle state: 2,603,404 bytes. Measured results from the accepted source run:

| Platform                     | Duration  | Frames/s | Feed latency p99 | Event-loop p99 | RSS after         |
| ---------------------------- | --------- | -------- | ---------------- | -------------- | ----------------- |
| Ubuntu / Xeon Platinum 8370C | 5469.52ms | 1096.99  | 393ms            | 97.06ms        | 267,304,960 bytes |
| Windows / EPYC 7763          | 8408.74ms | 713.54   | 1225ms           | 44.47ms        | 266,641,408 bytes |

These are concurrent CI fixture measurements with reference registry/storage, not production SLO certification. Native exchange capacity, runtime registry/recovery provisioning and 24h soak remain explicit operational/PHASE 20 acceptance work. LIVE mutations remain disabled; real private acceptance is NOT RUN. No PHASE 10 code was added.

Evidence: ignored phase9-source-final-ci.json/log, phase9-ci-source-final/{ubuntu,windows,docker} reports and phase9-source-final-artifacts-verified.json. Gate: **READY FOR PHASE 10** on the accepted source. A documentation-only main update records this decision; its final-main CI is checked separately before handoff.
