# PHASE 13 verification

## Baseline and gate

Fresh clean main **dbdf3c6ef65a3830176660f5f861cc1d535c6a2c**, fetched from origin. Prior phase docs, canonical roadmap/master prompt and accepted code were inspected before implementation. Full accepted housekeeping CI: [37938234587](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37938234587), [CodeQL 37938234586](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37938234586). Local baseline completed **2026-10-09T14:15:14.534Z**: format/docs/lint/typecheck/unit/HTTP/db:validate/build/runtime/clean/audit:dependencies/audit:secrets/audit:supply-chain all passed. Baseline had 3033 unit, 41 HTTP, eleven isolated deployments, and zero dependency vulnerabilities in all severities. Logs are retained in test-results/phase13; native PostgreSQL/Docker proof comes from complete GitHub CI, not a local substitute.

PHASE 13 is in progress; **NOT READY FOR PHASE 14**. The initial deterministic calculation module does not complete virtual account/ledger, certified PAPER Risk admission, durable shared liquidity, worker dispatch, conditional exits or restart-safe monetary effects. LIVE remains disabled. Migrations 1–34 and accepted PHASE 12 runtime invariants remain unchanged.

## RED and regression evidence

At **2026-10-09 14:15 UTC**, 27 calculation contracts failed against the not-yet-implemented functions (`PAPER_MODEL_NOT_IMPLEMENTED`), then passed after implementation. An initial Windows sandbox EPERM prevented test execution; that infrastructure failure is not counted as RED. The actual RED run executed all 27 tests outside that sandbox.

Further hardening RED executed 27 tests: five failed, 22 passed. Failures proved malformed `1e3` seed conversion and two invalid rates could throw during schema validation, a partially executed STOP could lack its sticky activation watermark, and partial FOK state could be admitted. Fixes guard conversion with canonical validation and reject those impossible states. All **54 targeted tests passed** at 2026-10-09 14:23 UTC. Coverage includes shared BUY/SELL volume and per-level depth caps, partial GTC, IOC/MARKET expiration, FOK rollback, actual LAST triggers, latency/no-lookahead, adverse price/limit guards, quote fee rounding, per-asset delta conservation, immutable caller input, serialization replay, 300 instruments, all four public exchange scopes, lossless 64-bit seed/sequence and fail-closed malformed/stale/future/missing evidence.

The clean deployment check includes the real compiled Paper exports and rejects source/test subpaths and monetary/grant/mutation APIs. Only the workspace importer was added to the lock; external versions/integrities, dependency/security policies and published migrations 1–34 remain unchanged. Accepted native Order/Risk/Portfolio/adapters and workflow enforcement are unchanged.

Full post-change local regression completed **2026-10-09T14:30:53.581Z**: format/docs/lint/typecheck/unit/HTTP/db:validate/build/runtime/clean/audit:dependencies/audit:secrets/audit:supply-chain passed, with **3087 unit / 41 HTTP**, **12 isolated production deployments**, and audit zero in every severity. Repeated targeted tests preserve all 54 cases after moving native-payload hashing outside the per-level fill loop; payloads/IDs are unchanged. Final document/type/build checks are repeated before publication. Exact-head full CI/CodeQL remains required; no future CI result is claimed.

Native PostgreSQL tests for a future durable Paper path are not substituted with pure unit fixtures; serialization replay alone does not prove a durable account, permanent event idempotency or shared liquidity across processes. The phase remains in progress and NOT READY FOR PHASE 14 even after this calculator increment passes CI.
