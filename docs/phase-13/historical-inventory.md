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

Candidate server export: `createPostgresPaperHistoricalInventorySource` from
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
The accepted Portfolio reducer can retain null free/available for a newly
acquired asset. This source must preserve those nulls and expose null spendable
plus `availabilityComplete: false`; total is not evidence of available funds.
Inventory completeness is distinct from spendability. A future coordinator
must reject any monetary debit whose required availability is unknown. No
availability, liquidity or financial authority is inferred from this capture.

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
Linux tests-first source `df5dc5c` then reaches the new contract under the real
non-BYPASS owner:1new failure with `PAPER_HISTORICAL_INVENTORY_SOURCE_MISSING`
after genuine START/financial commit, all28 preceding writer/book/valuation
cases pass. Platform43417492406 is intentionally RED, not acceptance; its other
native job also records the newly exposed pre67 selected-case count mismatch
(28pending versus the previous27). Three new exact-count unit contracts are
RED before updating metadata to29total/28pending. Actual job logs and all six
digest/window-verified diagnostic ZIPs are retained. The local Windows setup
failure remains distinct and is not relabelled as the feature RED.

The initial39 source unit contracts now pass, including100account completeness,
nullable availability, component provenance, uncertainty/deadline/price expiry
and forbidden input/authority boundaries. No new SQL source is accepted yet.
Candidate additive68 implements readonly catalog locking and capture. Six real
native cases pass in one fresh Windows PostgreSQL68 diagnostic; a separate
seventh case proves actual publisher/capture/user-FK blocking, account insertion
after capture settles and whole-catalog rejection on the next read. The sibling
case first exposed a JSON string extraction error in the new migration, then
passed after the extraction fix; this RED is retained. The concurrency fixture
first used ACCESS EXCLUSIVE, which can block cold function planning before the
intended user lock. Its corrected publisher ROW EXCLUSIVE lock retains both real
blocking assertions and all deadlines. Exact owner/pre67 metadata is now35total/
34pending; full accepted514 harness bytes and earlier guard/assertion bodies
reconstruct under new review contracts.

These local diagnostics use5ms network response latency, preserve SQL/response
bytes, clocks, assertions and budgets, and do not establish Linux owner or
aggregate acceptance. Zero-delay bootstrap/runtime-context failures and the
initial diagnostic pg-module load failure remain separate failed runs. Every
owned diagnostic server is stopped with postmaster PID absent. No published
migration is edited. Full regression,
populated upgrade/redeploy/reset, original owner suites and independent full
source/PR CI remain required. Published migrations1–67 are immutable; any
database addition must be a new migration, with no financial writer/grant change.

## Complete first-candidate regression — retained RED

Frozen candidate `ff069a0` completes all thirteen local commands without source
changes: twelve pass, including41HTTP, build/runtime, twelve clean deployments
and all three audits with zero dependency vulnerabilities. Unit results are
6,373pass/6fail of6,379. The same six historical guard-fixture failures reproduce
in [source Platform43423632559](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43423632559)
and [PR Platform43423992665](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43423992665);
both CodeQL workflows pass, native/Docker jobs are skipped, so neither Platform
run is acceptance. Their actual matrix artifacts/logs are retained separately.

The new full-predecessor review layer correctly rejects modified source before
older tamper tests reach their own guard. The repair peels that exact reviewed
layer from each test fixture before its original mutations. All original
assertions, expected error strings, pins and budgets remain; three new complete
file-hash contracts prove their original bodies reconstruct byte for byte.
All21 targeted fixture/history contracts pass after repair. A fresh full local
regression and full exact-head source/PR CI are still required. Runtime and
candidate migration68 are unchanged by this fixture correction. A separate
local populated-upgrade diagnostic stops in existing START evidence setup
before the upgrade and is not counted as upgrade/compiled acceptance; its server
is stopped. Real populated upgrade/redeploy/reset remains mandatory in CI.

**PHASE13 IN_PROGRESS / NOT READY FOR PHASE14.** Financial PAPER/LIVE dispatch
and positive native collateral credit remain disabled. Native AMEND remains
Binance Spot TESTNET only. No real private-exchange, production-soak or complete
Paper acceptance is claimed.
