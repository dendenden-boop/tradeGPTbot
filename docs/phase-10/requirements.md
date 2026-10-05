# PHASE 10 — Portfolio requirements

Baseline main: `accbcb56f4da146511b59695d234971ecf334195`; final PHASE 9 [CI 37230378615](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37230378615) succeeded. Scope follows PHASE 10 and sections 65–66 of the original master prompt: balances, positions, unified valuation, fill/fee/funding accounting and reconciliation. Order submission/state machine, risk allocation, Paper simulation and UI are excluded.

Primary observations remain scoped to server-owned exchange account, mode, wallet and market. Only Spot and BASE-face linear perpetual accounting are admitted initially; inverse/dated products remain unsupported until their explicit accounting gate. No credentials, URL or HTTP-provided tenant principal can configure a reader. Existing adapter/registry/auth/risk/LIVE invariants and published migrations remain intact.

Acceptance covers exact decimal conservation; weighted cost basis, partial close, short/hedge/flip; fee/rebate/funding currency separation; snapshot/delta overlap; permanent evidence deduplication and conflicting identity rejection; revision races; restart recovery; stale prices/balances; pending/unknown/reserved overlays; tenant isolation; atomic ledger/projection/inbox/outbox; bounded state and physical database cancellation. No unexplained reconciliation difference creates income or silently overwrites known cost basis. Valuation never reports an incomplete/stale partial sum as a fresh total.

Requirements, contracts and tests precede implementation. Baseline and full regression/CI must pass before READY FOR PHASE 11. PHASE 11 is not started by this task.
