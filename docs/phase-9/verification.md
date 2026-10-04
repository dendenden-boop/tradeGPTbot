# PHASE 9 verification

Gate: **NOT READY FOR PHASE 10**. Implementation and acceptance are in progress.

Baseline main: `20523a4455d79c9f4ff77b2cccf6d53d1d6b250a`. Before phase source changes, format:check, docs:check, lint, typecheck, test:unit, test:http, build, db:validate, test:runtime and test:clean passed on 4 October 2026 (18:01–18:05 UTC). 2217 unit tests and 41 HTTP tests; seven clean deployments. Dependency audit has zero vulnerabilities at all severities (407 dependencies). Ignored evidence: phase9-baseline-checks.json, phase9-baseline-*.log and phase9-baseline-audit.json.

Previous full main CI [37221754608](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37221754608) passed all three jobs. Published migrations tree at baseline: `7d846113c5801472e8b8a03cf4da034a55cb090e`. No production load, LIVE trading, private acceptance or PHASE 10 implementation is claimed.

## RED and repairs

Initial candle/store/engine/pool/native/worker/snapshot tests were written before their modules. Missing-module runs are scaffolding RED, not regressions in PHASE 0–8. During implementation, executed RED tests captured three revision/connection-accounting failures (phase9-hardening-red.log), partial gap repair (phase9-worker.log), three late-history/snapshot failures (phase9-late-history-red.log), the USDM public-versus-market endpoint error (phase9-usdm-route-red.log) and three restart/multiplicity/checkpoint integrity failures (phase9-restart-integrity-red.log). All are in new PHASE 9 code; completed adapter private/order implementations were not changed.

Repairs preserve slots until physical settling, increment published partial revisions on correction, subtract only proven gap coverage, prevent resurrecting expired populated history as empty, keep watermark monotonic, clear malformed known-key snapshots, route USDM trades through the existing market endpoint, keep restored history stale until reconciliation, include execution multiplicity in dedup hashes and reject impossible persisted empty data. Loopback tests prove hung real HTTP upgrade/WS ACK deadline and abort terminate actual sockets. Native ACK/normalization tests cover Spot and linear profiles across Binance, Bybit, OKX and HTX, including gzip and exact large IDs.

## Local regression

Final local checks all exit 0 on 4 October 2026, 19:07–19:11 UTC: format:check, docs:check, lint, typecheck, test:unit, test:http, build, db:validate, test:runtime, test:clean and audit JSON. **2277 unit tests / 96 files**, including **60 PHASE 9 tests**, plus **41 HTTP**. Eight isolated clean deployments include market-data and all four compiled read-only adapter subpaths; raw IO/testing subpaths are excluded. Dependency audit: **0 vulnerabilities at all severities**, 407 dependencies. Lockfile SHA256 `3ba0855b831263fcb9325dd6ee4d24cbc41d17c5819c2c713f625604e6199186`; only workspace importers changed, pinned dependency versions remain unchanged. Existing published migrations unchanged; new market schema is additive. Evidence: ignored phase9-final-checks.json, phase9-final-*.log, phase9-final-audit.json, unit.json, http.json and clean-install.json.

The load test uses **300 unique Binance Spot TESTNET keys**, **6000 native frames**, **three real loopback WS sockets** and **seven timeframes**, with zero dropped inputs. Its registry/store are explicitly test/reference models. JSON records hardware/runtime, duration, CPU/RSS, event-loop delay, latency, queue and state bytes. Initial synchronous draining showed a multi-second event-loop stall; bounded work/yield and asynchronous native delivery reduced it. Numbers vary with concurrent tests; CI artifacts retain their own measurements. This is neither a 6000 messages/s production certificate nor a 24h soak, and it does not benchmark 300 native order-book streams. Extended performance acceptance remains PHASE 20.

Docker CLI is not installed locally. The new PostgreSQL integration tests are wired into the existing isolated real-services CI runner, with a separate restricted ingest login; no local real-PostgreSQL result is claimed. Gate remains **NOT READY FOR PHASE 10** until all CI jobs and artifacts succeed for the final source.
