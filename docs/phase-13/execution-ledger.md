# PAPER execution ledger calculation

## Scope and baseline

This PHASE 13 increment starts from protected main **02ed2d2afc6e5e4fa90bc9e314181540c2dfaffe**, accepted through [PR43](https://github.com/dendenden-boop/tradeGPTbot/pull/43), [Platform40309262990](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40309262990) and [CodeQL40309263055](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40309263055). Its exact-main artifacts proved 4,991 unit / 41 HTTP per OS, 1,378 PostgreSQL tests, all owner/upgrade/Auth/Docker stages, twelve clean deployments and audit zero. The thirteen-command local baseline passed with all 823 tracked inputs unchanged before edits.

`calculatePaperExecutionLedger` on the pure `@ctp/paper-engine` root recomputes the existing complete [competition calculation](competition.md) and derives balanced postings from its new fills. It performs no I/O and accepts no separate fills, postings, balances, ownership, receipt, grant or permit. It neither authenticates market evidence nor authorizes a financial mutation. Published migrations 1–57, accepted native/financial runtime, dependency pins, lockfile and workflows are unchanged.

## Accounting contract

For each calculated fill, the result retains its original order ID, admission sequence and fill ID. One calculation transaction groups:

- base principal: `AVAILABLE = baseDelta`, `EXTERNAL = -baseDelta`;
- quote principal: `AVAILABLE = quoteDelta + quoteFee`, `EXTERNAL = -(quoteDelta + quoteFee)`;
- quote fee, when positive: `AVAILABLE = -quoteFee`, `FEE = quoteFee`.

The simulator already includes the fee in quoteDelta. Adding it back before posting principal prevents a second fee debit. Each pair balances independently in its own asset; BUY and SELL preserve the existing Spot Portfolio reducer's posting semantics. Fees retain the simulator's upward rounding to 18 fractional digits **per fill**, without a second aggregate rounding. Zero-value entries and zero net asset deltas are omitted; a minimum-scale sale fee may consume the entire quote proceeds.

Each order has canonical nonzero `availableDeltas`, sorted by asset. These are sums of AVAILABLE postings, not an additional ledger effect, balances or PnL. All arithmetic uses existing isolated lossless decimal functions; no money is converted to Number or rounded by global Decimal settings. Output amounts retain the common aggregate numeric envelope.

The calculation cause identity is `paper-fill:<original fill ID>`, independent of the accounting implementation version. It is a proposed permanent cause, not a database transaction ID or evidence of a committed fill. A future writer must enforce original fill uniqueness and exact semantic replay across all versions. A changed posting or scope for the same cause must conflict; changing a calculator version must never authorize a second debit.

The original complete competition result is returned unchanged. Its lossless priority, 300-contender / 1,000-level bounds, shared BUY/SELL volume, model/seed, slippage, latency, freshness, rule validation, STOP/FOK/IOC behavior and consumption remain authoritative **calculation semantics only**. WAITING, completed orders and failed FOK produce no postings; partial and IOC execution post only actual newly calculated fills. Any later contender failure rejects the entire calculation. Input is unchanged and output is deeply immutable.

## Required durable integration

No native acknowledgement, exchange order ID, common FILL event, ledger UUID, reservation change or dispatch permission is fabricated. Test-only native-shaped Portfolio fixtures compare arithmetic; they are not a PAPER production event path.

The future fixed PostgreSQL writer must authenticate complete server-owned input/current ownership and epochs, policies, rules/capabilities, controls/health, deadline and ACTIVE reservation immediately at the dispatch boundary. It must retain a durable attempt and one-use permit, serialize complete candidate priority and native trade/book consumption, and commit permanent fill replay, balanced ledger postings, common Order/Portfolio progress and hold lifecycle together. Do not issue a standalone liquidity grant or apply availableDeltas as a second monetary write. UNKNOWN retains its hold until trusted resolution; lost COMMIT returns no success and requires readonly reconciliation without blind mutation retry. JSON consistency, calculation identities and matching hashes prove none of that authority.

## Verification

Tests-first **be1e8795077f4572f0e8ac484ef956b54696c06c** reproduced 38/38 failures due to the missing export. The first implementation run passed 33 contracts and rejected five new fixtures missing size.asset or its updated asset binding; those fixture errors are retained, not runtime defects. Decimal branding repairs are test typing only. Two further boundary contracts cover minimum-scale fee/net-zero proceeds and 1,000 fills. The minimum fixture initially used invalid minNotional=null; correcting it to the existing valid zero policy leaves production validation unchanged. All 40 targeted contracts passed, including comparison with the existing Portfolio reducer, exact conservation, per-fill rounding, >2^53 quantities, immutable/serialized/permuted inputs, 300 contenders, consumed frames and stale/GAP/rule rejection.

The clean production deployment checks the compiled root export and rejects its private source subpath. Full new-head regression and Ubuntu/Windows/native PostgreSQL/Auth/Docker/CodeQL acceptance remain mandatory and are reported with exact SHA/run IDs in the implementation PR. Old native tests preserve existing invariants; they do not establish a not-yet-implemented durable PAPER fill writer. Real private exchange acceptance, crash/backup restore and production soak are not claimed.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** Final dispatch/attempt/permit, shared durable virtual execution, executed/partial lifecycle and trusted UNKNOWN resolution, operational feed composition, conditional exits, positions/PnL/reset remain outstanding. LIVE/PAPER financial dispatch and positive native credit remain disabled; native AMEND remains Binance Spot TESTNET only.
