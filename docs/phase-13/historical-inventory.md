# Post-execution PAPER tenant inventory

## Starting point and scope

Protected main `514f68240bb9f5890138af51a766c0173e08b4d4` accepts PR71 through
[Platform43392269284](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43392269284)
and [CodeQL43392269265](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43392269265).
Actual main evidence verifies6,329unit per OS,41HTTP,1,507PostgreSQL/49files/
24owners, all67migrations, populated upgrade/reset/restart, six artifact
digests/windows, twelve clean deployments, audit0 and strict protection.
All thirteen unchanged-main baseline commands pass again on1,045 frozen files.
Earlier PR71 pending descriptions retain their dated checkpoint scope.

The next server-owned readonly source must enumerate the complete bounded
tenant PAPER-account catalog in one transaction. Its supported state is exactly
one authenticated first pristine Spot BUY execution and zero to99 pristine
sibling books. Each sibling may contain only the already supported CREATED
drafts. Additional executions, reservations, UNKNOWN activity, uninitialized or
disabled accounts, unrecognized effects or any other unsupported history must
reject the whole inventory; they cannot be dropped, truncated or treated as
zero exposure. This is a declared support boundary, not general historical
execution or permission for another order.

## Contract

Proposed server export: `createPostgresPaperHistoricalInventorySource` from
`@ctp/paper-engine/risk`. Input uses the existing strict selector keys with
`kind: PAPER_HISTORICAL_INVENTORY_CAPTURE`, `executionKey`, `preparationKey`,
`startKey`, immutable `admission` identity and current `authorization` epochs.
Caller account lists, prices, projections, timestamps, SQL, role/profile or
credential overrides are forbidden. Server connection/endpoint authority stays
unchanged. The existing bounded admission transport must retain its four slots,
physical abort/deadline settling, uncertain-COMMIT refusal and no retry.

The fixed reconciliation RPC must retain GLOBAL → tenant → user → sorted account
→ book → metadata/head locking. Locking the user/account catalog closes FK
insertion phantoms. Capture authenticates the actual immutable execution and
current book/ledger/order/reservation/hold/liquidity through the accepted causal
proof; siblings use the unchanged pristine provenance proof. Capturing must not
adopt books, publish snapshots, change watermarks or perform any other DML.
Current ownership/permission/session epochs remain mandatory even on replay.

Return is exact MISSING for an absent execution, or immutable CAPTURED with a
complete supported catalog, current account epochs, original economic states,
current direct public prices, aggregate Spot valuation and normalized exposure.
Every account/book identity must occur exactly once. The private reservation
journal determines whether the target reservation is ACTIVE or RELEASED; the
legacy public parent row is not independently counted as another live hold.
Actual position plus remaining original bounded order is counted once, while
fee collateral remains separate. All balances contribute to equity once;
unrealized/realized PnL is disclosed separately, never posted or added again.

All funded assets and the executed instrument require exact current direct
LAST evidence in their configured public scope, even if the closed target has
zero quantity. No stablecoin parity, cost-basis fallback or caller price is
inferred. Missing/ambiguous/gapped/stale/conflicting evidence fails closed.
Current metadata may replace historical rules; the historical calculation keeps
its original economic time and maximum-price/fee bounds. Fresh capture time
renews neither original prices nor an execution/admission lease. Global finite
validity is bounded by every used original price clock and current rule expiry.

Limits are100 PAPER accounts,1,000 drafts,300 price heads and16MiB/400,000 nodes.
Oversized, cyclic, sparse or accessor-bearing input is rejected before schema
or hash traversal. Native version/revision IDs remain lossless strings. Missing
catalog members or wrong-scope references cannot become partial success.

`complete: true` refers only to the enumerated PAPER inventory in the declared
supported state. This source is not a RiskSnapshot certificate, policy/health/
control/loss validation, financial grant, transport permit, reservation writer
or dispatch path. Complete general historical inventory, UTC loss progression,
current certified Risk and atomic further execution remain later PHASE13 work.
The source cannot weaken UNKNOWN, release collateral or admit another order.

## Tests-first checkpoint — 13 November 2026

Thirty-six new unit contracts are RED with
`PAPER_HISTORICAL_INVENTORY_SOURCE_MISSING`, before implementation. Native RED
has been added to commit a genuine START execution before requesting the absent
source. The local Windows PostgreSQL67 diagnostic stops earlier with
`PAPER_RUNTIME_CORRUPT` in existing fixture runtime-context setup; it does not
reach the new API and is not counted as its native RED. Its actual log is
retained and the server is stopped with PID absent. A separate native-only
tests-first Linux CI checkpoint is published before runtime implementation.
No native result is claimed yet. Source/migration implementation, complete regression,
populated upgrade/redeploy/reset, original owner suites and independent full
source/PR CI remain required. Published migrations1–67 are immutable; any
database addition must be a new migration, with no financial writer/grant change.

**PHASE13 IN_PROGRESS / NOT READY FOR PHASE14.** Financial PAPER/LIVE dispatch
and positive native collateral credit remain disabled. Native AMEND remains
Binance Spot TESTNET only. No real private-exchange, production-soak or complete
Paper acceptance is claimed.
