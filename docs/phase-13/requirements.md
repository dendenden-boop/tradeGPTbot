# PHASE 13 requirements

## Starting point and scope

Fresh main **dbdf3c6ef65a3830176660f5f861cc1d535c6a2c** on 9 October 2026. PHASE 0–12 are accepted. Housekeeping main passed [full CI 37938234587](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37938234587) and [CodeQL 37938234586](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37938234586); main has mandatory PR, strict Ubuntu/Windows/real-services/CodeQL checks and administrator enforcement. Published migrations 1–34 remain immutable.

PHASE 13 implements the canonical [Paper Engine roadmap](../phase-0/implementation-plan.md): separate virtual account/ledger; real public market evidence; deterministic order simulation; starting balances in multiple assets; market/limit/stops and TP/SL; fees, adverse slippage, latency and partial fills; positions, realized and unrealized PnL. This phase does not implement Strategy Engine, Backtesting or UI. PAPER is an exact account mode; public source environment is not a private trading destination. PAPER has no connection or live credentials.

## Invariants and acceptance

- Same immutable Intent and server-owned Risk authorization gateway. A pure evaluation, caller snapshot or structurally matching port cannot authorize money changes.
- Atomic durable reservation, shared budget and virtual ledger effects; permanent request/event replay; conflicting replay rejected. UNKNOWN keeps its hold until authoritative resolution. Restart must preserve seed/model, order state, evidence watermarks, liquidity allocation and ledger history.
- Recheck current ownership, policies, rules, permission epoch, controls and deadline before a virtual dispatch. No changes to accepted native dispatch guarantees.
- Decimal arithmetic, explicit rounding, balanced postings per asset; starting capital has an identified external virtual funding counterentry. PnL is a projection, not a second monetary effect.
- One bounded durable liquidity allocation per instrument/source/event across competing paper orders. Fills are capped by observed volume participation and observed depth, never a repeated snapshot or a fabricated candle price. Deterministic ordering for competing orders is part of the model.
- No lookahead: execution evidence must be received and natively occur after modeled latency, and be fresh at evaluation. Missing/stale/conflicting/gapped evidence fails closed. Do not claim exact queue position or maker priority from L2.
- Server-selected, immutable model version/configuration and signed 64-bit seed. Explicit conservative slippage, quote fee rounding and capability limitations. Unsupported markets/semantics reject.
- Bounded queues, physical abort/deadline settlement, concurrency/restart/uncertain-commit tests, tenant/account/mode isolation and no access to credential ports.

## Implementation sequence

1. Requirements/contracts and RED tests for a pure deterministic Spot L2 taker model. This is a calculation prerequisite, not a production Paper gateway or financial writer.
2. Durable PAPER identity, account initialization, evidence/liquidity journal and isolated virtual ledger through additive schema authority. Prove replay, conservation, concurrency and restart.
3. Certified PAPER snapshot and atomic Intent/Risk reservation integration; virtual dispatch and reconciliation, cancellation and supported conditional exits. Preserve native semantics and permissions.
4. Real public-feed composition, Portfolio positions/PnL, bounded worker operation and complete cross-package acceptance.

**NOT READY FOR PHASE 14** until all scope is implemented and complete exact-head Ubuntu, Windows, native PostgreSQL/real-services/Docker and CodeQL CI passes. LIVE remains disabled. Accepted native AMEND stays Binance Spot TESTNET only; conservative collateral has no positive native credit. Real private exchange tests or production soak are not claimed.
