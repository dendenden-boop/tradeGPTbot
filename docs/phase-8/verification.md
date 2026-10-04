# PHASE 8 — HTX verification

Gate: **READY FOR PHASE 9** for the documented HTX read adapter scope. Full source CI and artifacts verified; source `a4fb504a4764599b2598ebd2a397efd0a3c9fa99`, baseline `0d36656d5942168a0689357ac8bb4fd364ceda80`. PHASE 9 has not started. This gate does not establish private-exchange, production trading or execution readiness.

## Verified baseline

Full local baseline passed before edits: format:check, docs:check, lint, typecheck, test:unit, test:http, build, db:validate, test:runtime, test:clean. 2002 unit + 41 HTTP; six deployments; audit all severities zero, 407 dependencies. Previous exact-main full CI [37204462284](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37204462284) SUCCESS. Evidence under ignored test-results/phase8-baseline-*; migrations unchanged.

## Reproduction and repairs so far

- New native contract tests were added before implementation; initial run failed on missing HTX modules (scaffolding RED, not a previously deployed regression).
- Real binary gzip on copied bounded text IO: 1 RED / 45 PASS. Fix bounded gzip decode before strict UTF8; malformed gzip, >1MiB output and invalid UTF8 terminate. Real HTTP/WS abort/deadline tests remain part of this suite.
- During new HTX implementation, tests captured 3 RED for reused snapshot cursor, same-order multiple executions incorrectly deduplicated as orders and incorrect derivative fee sign. Cursor rotation, composite fill ID selection and common positive-cost/negative-rebate convention fixed them. Subsequent 124 HTX tests PASS and typecheck PASS before adding further stream tests.
- Stream tests captured 3 RED for Spot private 20s heartbeat being closed after 15s and conflicting equal ticker timestamp/book version not requiring resync. Product-specific inactivity and conflicting-observation checks added. A fourth assertion was corrected to existing Core's documented generic source-establishment UNAVAILABLE envelope; completed Core was not changed to match the test assumption.

## Additional regression findings and public acceptance

Additional new-code RED tests captured full-book prefix hiding malformed suffix and missing derivative quote turnover (2 RED); contradictory/unknown success envelopes (3 RED); private position metadata race and conflicting observations (2 RED). Complete book validation, native trade_turnover mapping, envelope validation and post-await identity/clock checks fix these cases. Official derivative error mapping tests captured 6 RED: 1032 is rate limit, 1010/1034/1031 are not; 1253/12007 are authentication failures. A corrected pagination contract test separately captured 2 RED for stale/future REST position snapshots; native timestamp is now checked even for empty collections. The initial malformed position test input never reached transport and is not counted as reproduction.

Real public-only acceptance: **12/12 PASS**, both fixed profiles × server time, instruments, ticker, book, ranged candles and public ticker WS. Current native metadata unknown fields stay fail closed for new risk. Evidence: ignored test-results/phase8-htx-public-probe.json; no credentials/mutations.

## Final local regression

All checks completed with exit 0 on 4 October 2026, 16:39:31–16:43:59 UTC: format:check, docs:check, lint, typecheck, test:unit, test:http, build, db:validate, test:runtime, test:clean. **2175 unit tests across 87 files**, including **173 HTX**, plus **41 HTTP**. Physical loopback tests prove 16 hung private HTTP bodies occupy Core slots, abort destroys actual sockets and frees slots, deadline frees a hung body, gzip public WS reaches DATA, hung ACK closes, and private Spot native HMAC/source-close requires resync. HTX 300-instrument lifecycle fixture completes 180 native refreshes (54,000 puts), adapter recreation and A→B→A rejection; existing cross-adapter durable restart/corrupt-history regressions pass in the unchanged full suite. These bounded fixtures do not certify a production registry implementation or indefinite load.

Clean frozen install/build verifies **seven isolated deployments** (API/database/Core/Binance/Bybit/OKX/HTX), compiled factory-only export, mandatory registry and rejected raw IO/URL/testnet paths. Dependency audit JSON: **0 vulnerabilities at all severities**, 407 dependencies. Lockfile SHA256 `0cc914cced57d3ba384082da779d89f6837ba2fe5c95af9c22bd9e93ec682aa9`; only HTX importer added, pinned versions unchanged. Published migrations tree `7d846113c5801472e8b8a03cf4da034a55cb090e`; existing application/database/Core/adapter implementations and workflow unchanged. Evidence: ignored test-results/phase8-final-checks.json, phase8-final-*.log, phase8-final-audit.json, unit.json, http.json, clean-install.json. Final compiled public-only probe after strengthened response guards again passed **12/12**.

## Full CI acceptance

Source [CI 37217940082](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37217940082), exact SHA `a4fb504a4764599b2598ebd2a397efd0a3c9fa99`, completed **SUCCESS** on 4 October 2026 at **16:54:47 UTC**. All three jobs SUCCESS: Checks (ubuntu-24.04), Checks (windows-2025), Real services and Docker smoke. The existing workflow was not modified.

Downloaded and inspected all three sanitized artifacts under ignored test-results/phase8-ci-source/{ubuntu,windows,docker}; full log saved as phase8-source-ci.log. Both OS reports match 2175 unit / 173 HTX / 41 HTTP, zero failed tests, seven clean deployments, identical lockfile SHA and runtime PASS. Both CI audit steps report no known vulnerabilities; frozen install leaves lockfile unchanged. Docker reports: database **199 tests PASS**, dependency lifecycle **3 tests PASS**, integration PASS, authentication hardening/runtime/load PASS, migrations upgrade preservation/repeated deployment/role checks PASS. Smoke PASS: 46 authentication requests, SMTP boot-down/recovery, PostgreSQL/Redis recovery and graceful shutdown (318ms). **2418 distinct tests** total (2175 + 41 + 199 + 3); duplicated OS executions, deployment checks, smoke requests and public probes are not added to this test count.

The acceptance documentation commit changes no source/runtime/workflow behavior; its current-main workflow is also checked before handing the phase back. The immutable source-run link above is the artifact-backed acceptance evidence recorded by this document.

No private account credentials or exchange acceptance grant supplied: real private exchange reads/mutations **NOT RUN**. Protocol fixtures and local HTTP/WS integration do not establish production/private-exchange readiness. LIVE mutations are disabled and no native write endpoint is whitelisted. TESTNET/DEMO, unsupported order/algo/account-mode operations and production registry/rate service acceptance remain unproved rather than implied by fixture capabilities. No live order or published migration was sent/applied by this phase. PHASE 9 implementation remains outside this change.
