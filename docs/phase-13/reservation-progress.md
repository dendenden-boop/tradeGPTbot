# PAPER remaining-liability arithmetic

## Scope and accepted baseline

Starting protected main is `f304cf670017b8e040ee530e9d155dc1a6654c63`, accepted through [PR37](https://github.com/dendenden-boop/tradeGPTbot/pull/37), [Platform39606907931](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39606907931) and [CodeQL39606908023](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39606908023). All thirteen fresh local baseline checks passed with795tracked inputs unchanged. Published migrations1–54 remain immutable.

`calculatePaperReservationProgress` is a pure, bounded historical calculation exported from `@ctp/paper-engine`. It is a prerequisite for a future trusted remaining/release writer, not that writer. No SQL, permissions, Risk/Order/Portfolio admission, UNKNOWN lifecycle or dispatch behavior changes.

## Inputs and identities

The strict input contains only `original` and `fills`. Original includes the original time, model, instrument/rules, book/trade and command; the existing Risk envelope calculation recomputes its original lifetime bounds. No caller envelope, current timestamp, balance, status, resolution flag or release instruction is accepted. Original evidence must be valid at its original time. This does not establish current freshness, ownership or authentic persisted issuance.

At most1000fill entries and4MiB parsed content are accepted. Capacity applies before deduplication. Every fill has the existing model's bounded `paper-<64 lowercase hex>` identity and exact quantity, price, quote notional/fee and signed base/quote deltas. These are content checks: an ID or matching economics cannot authenticate its originating order, evidence, shared liquidity, completeness or posting.

Identical fill identity/content is counted once; conflicting reuse rejects the whole calculation. Sorted unique IDs make input permutation and JSON roundtrip deterministic. This is not durable idempotency, restart recovery or per-hold ordering. The future writer must bind complete immutable fills to the exact durable order/intent/account/model and retained original allocation, with permanent replay/tombstones and causal book ordering.

## Exact arithmetic and conservation

Every fill must have positive lot-aligned quantity and tick-aligned price within the original execution price bounds. The calculation verifies exact notional, quote commission rounded up to18fractional digits per actual fill, and both signed deltas. Unsupported precision, excess cumulative quantity, mismatched economics or a negative arithmetic residual rejects wholly. A private120digit Decimal constructor isolates calculations from global Decimal configuration; quantities, lots and money never pass through Number.

For remaining quantity `R`, original lot step `s`, original maximum price `P` and original fee rate `f`, future quote fee is `(R/s) × ceil18(s × P × f)`. BUY future quote principal is `ceil18(R × P)` in addition to that fee. SELL keeps base quantity `R` and quote commission as separate liabilities; neither expected proceeds nor another asset/account funds commission. A proven zero fee produces no synthetic quote debit.

For every original positive debit, the result contains `original`, cumulative `spent`, future arithmetic `remaining` and `surplus`, satisfying exactly `original = spent + remaining + surplus`. BUY spent is actual quote notional plus fees. SELL spent is base quantity and quote fees separately. Surplus is a mathematical residual, not available cash or a release. No iteration is proportional to the number of lots.

The remainder is not a new order: a positive remaining lot below initial minQuantity stays positive. FOK accepts empty or complete progress only. IOC/MARKET model expiry does not remove the unfilled arithmetic bound. Zero remaining quantity does not declare a terminal order or authorize releasing collateral.

The immutable result retains the original envelope, its original computedAt and exclusive validUntil; historical recomputation cannot renew freshness. Current admission and final dispatch must separately validate current rules/policies/ownership/health and trusted lifecycle state.

## Authority boundary and next work

This API neither captures evidence nor posts fills, changes reservations/Portfolio holds, resolves UNKNOWN, persists terminal tombstones, creates a RiskGrant/permit or dispatches. In particular, removing a caller UNKNOWN field does not authenticate ACTIVE: serialized content is never authority. The accepted durable UNKNOWN writer continues retaining the complete original vector. Any future reduction must authenticate original issuance and complete definitive evidence, post economics exactly once, serialize against fill/cancel races, retain uncertainty, and update common holds/watermarks and a durable terminal tombstone atomically. An uncertain COMMIT grants no release; reconciliation must be read-only and restart safe.

## Verification evidence

Tests-first `a173fc0` recorded81missing-API RED cases before implementation. The first attempt also had a strict-frame fixture error and is preserved separately; it is not product RED. An additional large-quantity fixture incorrectly used nullable maxQuantity; its80/81 run and subsequent fixture correction are retained, with the production schema unchanged. Typecheck also caught readonly fixture assignments; whole-record fixture replacement corrected them without relaxing types.

Tests-first `ce63bf1` adds a candidate hardening RED: partial FOK initially returned a calculation. The guard now rejects it; empty/full FOK and IOC/MARKET retained remainder cases pass. The filtered RED run intentionally selected two FOK cases (one failed, one passed); its83excluded cases are not full-suite acceptance.

The final targeted run passed418cases in six suites:85new progress cases and333unchanged envelope/coverage/model/commitment/journal cases. Thirty-two BUY/SELL/type/fee scenarios exercise every prefix of ten actual model fills, asserting exact vector conservation, monotone spent/remaining/surplus and enough remaining coverage for all future actual costs. Tests also cover one-atom commissions, sub-minimum remainder, global precision changes, large lossless lot counts, duplicate/conflicting IDs, invalid economics/shape/authority fields and bounded input.

Full frozen-source regression and exact source/PR/protected-main Ubuntu/Windows/native PostgreSQL/Auth/Docker/CodeQL, artifact digests/producer windows and strict branch protection remain acceptance requirements. Actual execution evidence belongs in the implementation PR and completion checkpoint; targeted GREEN alone is not full acceptance. No new PostgreSQL/restart proof is inferred from this pure calculation.

**PHASE13 IN_PROGRESS / NOT READY FOR PHASE14.** Trusted release/tombstones/terminal resolution, CANCEL controls, final dispatch/attempt/permit ordering, operational composition and durable virtual execution remain outstanding. LIVE/PAPER financial dispatch and positive native credit remain disabled. Native AMEND stays Binance Spot TESTNET only. Real private exchange acceptance, crash/restore and production soak are not claimed.
