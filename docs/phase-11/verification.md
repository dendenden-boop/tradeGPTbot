# PHASE 11 verification

Gate: **READY FOR PHASE 12**. PHASE 11 acceptance passed on the exact source commit below. PHASE 12 has not started. LIVE execution is disabled; no real exchange mutation was performed.

## Baseline

Started from clean main `0a078887bc79ff171abb2ce0b506bacddeb6fbd0`, the accepted PHASE 10 hardening. Format/docs/lint/types/2340 unit/41 HTTP/build/schema/runtime passed before implementation. Baseline clean initially exhausted native memory during parallel builds; a complete sequential retry passed nine isolated deployments at 10:25:14 UTC, 5 October 2026. Audit exited zero with every severity zero across 407 dependencies. Published migrations and CI policies remain unchanged.

## RED reproduction and fixes

The initial missing reducer produced seven failures. Subsequent contract tests reproduced partial execution-average loss and native UNKNOWN weakening (two failures), quantity/notional conflict, definitive PLACE rejection remaining blocked, unchanged-native gap recovery, premature attempt resolution, cancellation after rule replacement and recovery of an order created before its persisted intent (one failure each). Fixes preserve cumulative accounting, immutable placement identity, current cancellation rules, durable uncertainty and positive causal recovery evidence. Lost-response acceptance uses a real loopback HTTP request whose response socket is destroyed after exchange acceptance; restart reconciliation performs one total POST.

Authorization tests reproduced principal revocation while persisting the claim (one unit failure), acceptance of an expired transport permit (one SQL-probe failure), and expiry during delayed atomic consumption (one SQL-probe failure). The service rechecks principal authorization after claim persistence. SQL authorizes only an exact, unexpired, one-use permit within the saved deadline. Its atomic update uses actual PostgreSQL `clock_timestamp()`, rather than the transaction-start timestamp.

Restricted-role SQL reproduction found acceptance of a direct Risk-table grant (one failure). Admission now rejects unexpected memberships and direct privileges; execution cannot forge approvals or write the monetary ledger. Intent/order/attempt/outbox changes are atomic. Portfolio execution adoption links an already committed journal and ledger posting; duplicate/restarted delivery cannot create another monetary effect.

Fresh offline clean installs reproduced absent lodash/nodemailer full registry metadata despite an admitted frozen graph. The harness now verifies the exact frozen source graph online before offline installation, checks its lock hash, and retains all supply-chain policies and the existing derived-graph verification. No external dependency version changed. These RED cases belong to the new PHASE 11 implementation and harness; they are not claimed as defects in accepted PHASE 10 trading semantics.

## Local evidence

Targeted Order Engine tests: **31 unit PASS**. All nine exact migration SQL files passed on PostgreSQL WASM. A prepublication store probe passed **17 scenarios**, using real SQL/RLS with a test-only pg shim; two physical socket/row-lock tests were excluded. This is not native PostgreSQL/network/concurrency acceptance. The committed real-service suite contains **19 PostgreSQL cases**, including physical abort/deadline settlement, permanent idempotency, restart, restricted roles, exact TESTNET ownership and additive PHASE 10 upgrade.

Final local regression completed at **12:58:32 UTC, 5 October 2026**: format/docs/lint/types/**2371 unit / 41 HTTP**/build/schema/runtime/clean all exited zero. Ten isolated deployments passed with the original lockfile SHA-256 `98b93b061179a31f319e4089af4627369581175b7c5ea59e951f843bc62f8a82` unchanged. Audit exited zero: every severity zero across 407 dependencies. Local commands use `pnpm_config_workspace_concurrency=1`, one V8 pool worker, 1024MiB heap / 4MiB semi-space (lint 2048MiB) because native builds exhausted this workstation's memory. The final SQL probe passed using one Vitest thread / 256MiB heap after native-memory failures in fork mode. No CI configuration was weakened. Evidence is retained in ignored `test-results/phase11-*.log/json`; local Docker is unavailable, so real-service acceptance must come from CI.

## CI acceptance

Full [source CI 37313570241](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37313570241) passed at **13:10:27 UTC, 5 October 2026**, on `30ae642d7436d025bce105caf0824c33ea99c1c6`. All three jobs succeeded: Ubuntu 24.04, Windows 2025 and real-services/Docker. Downloaded job reports and logs were machine-verified against the exact SHA at 13:12:04 UTC; evidence is retained in ignored `test-results/phase11-source-artifacts-verified.json` and `phase11-ci-source/`.

Each OS passed **2371 unit / 41 HTTP**, build, schema, format/docs/lint/types/runtime, audit and ten isolated deployments. Lock SHA-256 matched the local frozen source above. Order Engine contributed **31 unit**; existing Portfolio 60, HTX 215 and Market Data 61 unit cases stayed green. Market Data fixture retained 300 instruments / 6000 trades / three connections / seven timeframes with zero drops. Both dependency audits reported no known vulnerabilities.

Native PostgreSQL passed **244 integration cases**, including **19 Order Engine**, 17 Portfolio and nine Market Data. Physical abort/deadline settlement, expired/delayed one-use permits, permanent idempotency, restart/replay, monetary adoption and outbox rollback passed. Fresh, repeated, non-bypass owner and exact PHASE 10 upgrade paths passed; prior counters and Portfolio data survived, and no historical commands were invented. All nine migrations are now published and remain immutable.

Docker service recovery, authentication, SMTP isolation and built-container smoke passed; smoke made 46 authenticated requests and shutdown completed in 376ms. Three dependency lifecycle cases also passed. Total: **2659 distinct tests** (2371 + 41 + 244 + 3); OS repetitions and smoke requests are not counted twice. This confirms PHASE 11's documented execution contract, not production/LIVE or exchange-private credential acceptance. Only verification/README publication follows this source acceptance; the unchanged full push workflow checks that main commit again.
