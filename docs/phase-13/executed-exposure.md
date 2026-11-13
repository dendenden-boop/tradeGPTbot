# Executed-order exposure calculation

## Starting acceptance and scope

Protected main `e078554bd5b56b556f36af4db8ec333a45f01834` accepts PR70 through
[Platform 43382582643](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43382582643)
and [CodeQL 43382582572](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43382582572).
Actual reports confirm 6,276 unit per OS, 41 HTTP, 1,507 PostgreSQL cases,
24 owner suites, migration67 populated upgrade/reset/restart, twelve clean
deployments and audit zero. Six own-main artifact digests and producer windows,
old case retention and strict five-context branch protection are verified.
The earlier PR70 pending/RED checkpoints retain their historical meaning.
All thirteen unchanged-main baseline commands pass again on 1,040 frozen files.

The next prerequisite is pure exposure arithmetic for one already calculated
first pristine Spot BUY transition. It must replay the original accepted
transition at its original time, mark the resulting position at a current
direct public LAST price, and include the remaining order liability exactly
once. Its order, reservation and Portfolio hold are different representations
of the same remaining effect. Fee collateral is separate from notional.

The proposed root export is `calculatePaperExecutedExposure`. Input is strict
`now`, `asOf`, `executionInput` and `currentMarket` JSON content. The existing
first-transition calculator reconstructs fills, cash, position, reservation and
hold progress. The supplied original economic time must not move to the current
capture time. Historical rule/admission expiry does not invalidate an already
completed historical calculation; it grants no permission for new execution.

Current snapshot scope, logical/database instrument identity, asset pair,
metadata and all original publication/ticker/book clocks must agree and remain
fresh. Current metadata may replace the historical rule version. The original
execution maximum still bounds the remaining order; a lower current mark cannot
shrink its retained reservation. Missing, stale, conflicting, UNKNOWN,
nonpristine or unsupported content fails closed. Arithmetic must preserve the
common decimal envelope and reject unrepresentable products without rounding.

PARTIALLY_FILLED retains one order/reservation identity and its exact remaining
hold. FILLED and definitive EXPIRED retain any actual position but no pending
exposure or hold. Unfilled FOK contributes zero. WAITING is not an executed
transition. Unrelated holds cannot be silently omitted.

The output is deeply immutable calculation content with explicit
`coverage: SINGLE_EXECUTED_ORDER` and `tenantInventoryComplete: false`.
It values the position produced by this first execution, not every funded asset
or wallet balance. It computes no equity, loss baseline, daily PnL, aggregate
tenant budget, certificate, grant, transport permit, monetary event or posting.
JSON/hash/identity replay is content determinism, not authenticated storage,
durable idempotency, restart recovery or reconciliation.

A future fixed source must authenticate complete durable tenant inventory and
coherent prices/hold watermarks. A financial writer must independently repeat
current policies, ownership/epochs, health/controls/circuits, rules, loss and
budget admission in its atomic transaction. This prerequisite does not relax
accepted pristine-only readers or admit another order. Continued execution,
SELL/exits and public worker composition remain outstanding.

## Tests-first checkpoint — 13 November 2026

Forty-seven new unit contracts are RED with
`PAPER_EXECUTED_EXPOSURE_MISSING`; no implementation exists at this checkpoint.
They cover partial/terminal/IOC/FOK accounting, retained collateral, exact
decimal arithmetic and overflow, historical versus current metadata/clocks,
freshness, scope, UNKNOWN, immutable deterministic content and hostile bounds.
Ignored reports: `test-results/phase13-executed-risk/red.json` and `red.log`.
These are missing-feature contracts, not defects in the accepted runtime.

Initial implementation passed35/47 new contracts and5/7 predecessor-root
guards. The new calculation incorrectly assumed applied fill IDs could not
remain in Portfolio.pending. It now requires exactly the IDs of its recomputed
fills, preserving the existing Portfolio reducer. The appended pure export is
removed only through an exact full-predecessor SHA-256 check; all older root
assertions/hashes stay intact. Six additional export tamper contracts reject
prefix/trailing/body changes, duplication and missing additions. All218 targeted
cases pass, including the original47 and prior transition/progress contracts.
Complete frozen regression and independent exact-head CI are pending.
Published migrations1–67 and financial/Auth/adapter runtime must stay unchanged.
No new migration or database grant belongs to this calculation increment.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** Financial PAPER/LIVE dispatch
and positive native collateral credit remain disabled. Native AMEND remains
Binance Spot TESTNET only. Real private-exchange tests, production soak and
complete Paper acceptance are not claimed.
