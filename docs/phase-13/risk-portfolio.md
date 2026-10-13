# PAPER Risk Portfolio inventory

Starting main: 4cf1724e592683177c1c8a36d84d63e6ce060264, accepted through PR #13 and exact-main CI 38393505441 / CodeQL 38393505453. Published migrations 1–42 are immutable. PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.

The next increment supplies the complete same-tenant PAPER account/book inventory prerequisite for aggregate Risk limits. The current book source captures one account only and cannot prove completeness across the tenant. Native Risk admission remains TESTNET/DEMO; its mode guard is not widened.

- Server-owned isolated read-only factory createPostgresPaperRiskPortfolioSource; read(authenticated PaperOwner, io), close only. No client-supplied accounts, books, balances, timestamps, credentials or persistence implementation.
- One bounded PostgreSQL READ COMMITTED transaction; GLOBAL shared → tenant exclusive → sorted account/book locks. Enumerate all owned PAPER accounts, including accounts which cannot currently pass ownership/funding/book checks. Missing or conflicting evidence for any inventory member rejects the whole capture; never silently return a subset. The requested target must belong to the inventory.
- At most 100 accounts, 1000 aggregate drafts and 1 MiB encoded source. Capacity rejects wholly. Preserve original immutable configuration/funding/book receipt/seal, balances and snapshot times. Capture current epochs/version/client counters and common CREATED draft identities losslessly; sort account identities deterministically.
- Fresh current read asOf does not renew original snapshotAt, imply market/FX/loss completeness or authorize money. UNKNOWN/active financial activity remain unsupported and fail closed until separately accepted lifecycle. No book, ledger, reservation, decision, evidence, outbox or counter writes.
- Physical abort/deadline/close settlement, four pending slots, no automatic retry or result after uncertain COMMIT. Exact content identity excludes capture time and remains stable after restart only if the retained source graph is unchanged.
- New additive authority/migration only. Prior single-account source and native Risk/Order/Portfolio/adapters stay unchanged. Existing runtime roles must not gain the new read authority.

Acceptance requires native RED→GREEN, two accounts/tenant isolation, missing/disabled/corrupt sibling denial, catalog replacement and exact counters, restart/concurrency/lost read COMMIT, bounded physical settlement/capacity, non-BYPASSRLS owner and populated 42→43 upgrade, deployments, full local regression and complete Ubuntu/Windows/PostgreSQL/Docker/CodeQL CI. No certificate, hold or Risk admission is claimed by this read source. LIVE/PAPER dispatch/positive native credit remain disabled; native AMEND remains Binance Spot TESTNET only. Real private exchange acceptance and production soak are not claimed.

## Candidate checkpoint

## Complete PAPER Risk inventory RED and candidate

Native test-only **cfded06cf5477068b0a54399c22b301663fccbb3** reproduced exactly one absent-inventory factory failure after real two-account configuration/funding/common bootstrap in [source CI 38398057190](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/38398057190) and [PR CI 38398067518](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/38398067518): **978 existing PostgreSQL passed / one new failed / zero skipped** in each run. Both OS jobs and CodeQL 38398057212 / 38398067667 passed; all 37 prior source owner contracts passed. Artifacts verified 2026-10-13T12:54:22.951Z. These intentional RED failures are reproduction, not acceptance.

All 24 final private decoder contracts failed against an unwired private stub, then passed against the complete bounded decoder. The stub is fully replaced and never exported or used by a production factory. Initial fixture lint/type issues were fixed without suppressions; byte-cap proof uses valid hashed receipt content rather than an unknown padding field.

Candidate adds isolated capture-only role/RPC and complete tenant inventory, original common-book provenance and historical snapshot time, lossless account epochs/draft identities and no financial writes/grants. It freezes the tenant/user FK row before bounded catalog enumeration and sorted account/book locks. Missing/disabled/corrupt/UNKNOWN sibling rejects wholly. Native 22-case acceptance, new seven role-graph cases, physical lost read COMMIT/abort/deadline/slots/close, catalog FK insertion, privilege replacement and populated published-42 upgrade are required. Additive 43 precedes only the new factory; published 1–42, prior single-account source and accepted native runtime stay unchanged. Full local regression and complete candidate/source/PR/main CI are pending.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**. This source is not a certificate, reservation, active hold, Risk admission or virtual dispatch. LIVE/PAPER dispatch/positive native credit disabled; native AMEND Binance Spot TESTNET only. Real private exchange acceptance and production soak not claimed.
