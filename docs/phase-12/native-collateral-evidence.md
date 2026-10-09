# Native collateral evidence and attribution boundary

## Current result

The Binance collector is read-only observation code. It does not certify a monetary amount, publish a reservation, resolve a Portfolio hold or grant a transport permit. Its before/order, account balances and after/order responses have actual receipt times, lossless identities, current metadata and known ordinary LIMIT/GTC eligibility. Matching observations are necessary evidence, not sufficient financial attribution.

The proposed partial Portfolio/Risk projection was excluded from runtime and preserved as a local unaccepted draft. No native reflection SQL publisher or additive migration 35 has been created. Published migrations 1–34 are unchanged. Production-issued holds remain conservative and unreflected. On 9 October 2026 the user explicitly accepted this conservative policy as a PHASE 12 limitation and required positive native credit to remain disabled.

## External protocol limitation

Binance defines [locked](https://developers.binance.com/en/docs/products/spot/faqs/spot_glossary) as an aggregate including open orders and other services. The [account response](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/ws-api/account) contains per-asset free/locked balances, without a per-order collateral owner or amount. The [REST consistency contract](https://developers.binance.com/en/docs/products/spot/rest-api) explicitly describes asynchronous data sources. HTTP receipt freshness and an account update time do not establish that all order and balance reads observe the same Matching Engine cut.

Consequently these observations alone cannot distinguish:

1. The owned open order reserves principal 10 and aggregate locked is 10.
2. Order reads still show that order from a lagging source after its definitive outcome, while another service locks 10. A newer account update does not identify the owner of those locked funds.

Both histories can produce identical order/balance/order responses. A SHA256 hash, a server-owned collector, a durable journal or a PostgreSQL lock cannot repair missing exchange-side causality. Crediting 10 in the second history can increase spendable funds without evidence. A native quantity-times-limit-price calculation is a proposed profile assumption, not an authoritative per-order balance proof.

The fixture demonstrates that the collector exposes no amount/grant/reservation field. It does not prove that an ambiguous aggregate can be attributed. The private native eligibility checks reject unsupported fields, SOR, lists, iceberg, quote-budget, nonworking, non-LIMIT/GTC and ambiguous identity/clock evidence; those refusals do not solve cross-source attribution.

## Decisions still required before positive credit

A positive reflection publisher requires a verified exchange/profile contract giving per-order lock provenance and a causal account/order cut, or a demonstrated equivalent source protocol. Then the implementation must derive the amount server-side, atomically bind its immutable journal to current Order/reservation/permission/Portfolio versions, preserve the fee and UNKNOWN bound, invalidate on new cuts or native changes, and pass real PostgreSQL replay/restart/concurrency/uncertain-COMMIT tests. No such acceptance is claimed now.

The accepted policy retains the full local hold in addition to native free/available for unsupported attribution. This underestimates spendable balance; it does not post a second monetary ledger effect or duplicate logical order exposure. With native free 990, locked 10 and local hold 10.01, the conservative result is 979.99; a proven principal attribution would permit 989.99 while retaining the fee 0.01. The user's decision changes the previously recorded PHASE 12 completion requirement explicitly. It is not successful native attribution. The native PostgreSQL contract must prove that observation/replay leaves the full hold, reservation, book and monetary ledger unchanged.

LIVE is disabled. PHASE 13 has not started. Overall PHASE 12 acceptance remains NOT READY FOR PHASE 13.
