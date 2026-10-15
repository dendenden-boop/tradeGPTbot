# PAPER multi-asset reservation coverage

This PHASE 13 increment starts from protected main **1cf74aaf5f7ec5a55f4fa6d08a4a3a3312c807a5**. The complete thirteen-command baseline passed after correcting the local PATH to pinned Node 24.20.0. The original environment failure (nested pnpm selected system Node 24.19.0) is retained separately and is not acceptance.

## Purpose and contract

`calculatePaperReservationCoverage` is a pure arithmetic prerequisite exported by `@ctp/paper-engine`. It recomputes the accepted lifetime execution envelope from the full original command, current rules, public book/trade and model; a precomputed envelope or debit vector is never accepted. It takes one bounded list of up to 32 unique asset availability amounts. Availability must eventually come from the exact account's certified Portfolio state after active and UNKNOWN holds. Supplying an object to this calculator does not prove that provenance.

BUY covers quote principal plus all per-fill rounded quote fees. SELL covers base principal and quote fees independently, without expected proceeds, cross-asset conversion or cross-account pooling. Every positive debit must be fully covered by that asset's availability; a missing asset or even one fractional atom of shortage rejects the entire calculation. A proven zero fee creates no quote liability or fabricated balance. Duplicate assets reject, including identical duplicates. Free/total balance aliases, caller fee vectors, owner/credential/URL/grant overrides and unknown fields reject.

The immutable result retains the complete envelope, model/rules/command and exclusive freshness deadline. Each positive debit contains its asset, amount, supplied availability and exact remaining amount. All money uses existing canonical 20-integer/18-fractional-digit storage amounts and private common decimal arithmetic. There is no monetary Number conversion, fee clipping or iteration proportional to order lots. Input asset order cannot change the debit vector.

## Risk integration boundary

The accepted common Risk evaluator currently proposes one reserve asset and proves fees in that asset. PAPER SELL needs base principal plus quote commission, and per-fill quote fee ceilings can exceed a single aggregate fee multiplication. A future PAPER gateway must preserve this entire vector atomically; translating it to the native scalar proposal or silently changing the fee asset would be unsafe. Native Risk semantics are unchanged. This is a compatibility requirement for the unfinished PAPER integration, not a claim that native trading has a defect.

This calculation does not check policies, portfolio completeness, ownership, permission epochs, capabilities, controls, loss history or pending exposure. It creates no certificate, Risk decision, reservation, Portfolio commitment, transport permit, ledger posting or virtual fill. JSON/restart determinism proves arithmetic only. Certified capture, aggregate budget enforcement, durable vector reservation/UNKNOWN holds, final validation and financial execution remain outstanding. Independently read source objects must not be combined into financial authority.

## Verification checkpoint

Before implementation, the public entrypoint contract produced one semantic RED failure: `PAPER_RESERVATION_COVERAGE_MISSING`. After implementation **76 targeted tests passed**, including 32 comparisons against ten actual `evaluatePaperOrder` fills across BUY/SELL, MARKET/LIMIT/STOP variants and four fee rates. Contracts also cover exact coverage, one-atom shortfalls in each SELL asset, missing quote commission, per-lot ceilings, zero fees, amounts above Number precision/full storage range, duplicate/invalid/bounded inputs, changed rules, stale/unbounded execution evidence, deterministic immutable replay and no grant identities. The clean deployment check verifies the compiled pure export and malformed-input rejection.

Full local regression and exact-head Ubuntu/Windows/PostgreSQL/real-services/Docker/CodeQL acceptance are pending at this checkpoint. No migration, native financial runtime, dependency pin or CI workflow changes are made; published migrations 1–46 remain immutable. Local native PostgreSQL/Docker execution is not claimed.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**. LIVE/PAPER financial dispatch and positive native credit remain disabled; native AMEND remains Binance Spot TESTNET only. Real private exchange acceptance and production soak are not claimed.
