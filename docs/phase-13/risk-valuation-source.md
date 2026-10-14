# Server-owned PAPER Risk valuation source

Starting protected main: **cab8fa80b8f6095313fca91a39cebf3f967b13d4**. PR #15 and exact-main CI 38441538806 / CodeQL 38441538295 accepted the pure inventory valuation. This increment connects that calculation to retained PAPER books and actual durable public Market Data heads. Published migrations 1–43 are immutable; additive 44 must precede this new binary.

## Contract and authority

**createPostgresPaperRiskValuationSource** is available only from **@ctp/paper-engine/portfolio**. Deployment supplies its own PostgreSQL URL/environment. **read()** accepts an authenticated PAPER owner and abort/deadline context only: no prices, portfolio, quote, account list, SQL backend, clock or credential/endpoint override. Authentication must supply the owner; a tenant UUID is not authentication. There is no HTTP publisher or financial writer.

The physical reader owns at most four sockets, with no hidden queue, 1s connect / 2s statement / 2.5s query / at most 3s total bounds. Abort, deadline and close destroy sockets and wait for physical settlement. Only known read COMMIT can return a result. Lost COMMIT returns UNCERTAIN without retry or source; recapture after restart is a new read. Expiry is checked again after settlement.

Isolated NOLOGIN group **ctp_paper_risk_valuation** has schema usage and execution of **ctp_paper.capture_risk_valuation(jsonb)** only. Startup and every SQL capture independently reject unsafe group/login attributes, additional membership, table/column/function/schema authority or ownership. No configuration/funding/ledger/order/Risk table privileges or financial functions are granted.

## Coherent capture

The fixed SQL RPC locks GLOBAL shared → tenant → verified user FK catalog → sorted PAPER accounts → retained books. It invokes the accepted private book proof, preserving original receipts, seals, snapshot times, common CREATED drafts and exact current epochs. Missing/disabled/unconfigured/corrupt/UNKNOWN or active-finance sibling rejects the entire inventory; no subset is returned. Original seed money is never reposted.

After proving the complete inventory, bounded SHARE locks on instrument, rule and snapshot-head catalogs prevent concurrent metadata replacement, head mutation and insertion phantoms for the capture. Existing public publishers can wait until read COMMIT. This conservative catalog locking has a throughput cost; no production performance or soak acceptance is claimed. A future atomic coordinator must retain a consistent lock order and revalidate at financial dispatch, rather than treating an earlier read as authorization.

Every funded nonquote asset requires exactly one active direct Spot instrument/head in its account's retained public exchange/region/environment. Multiple matching markets reject as ambiguous. Quote identity requires no fabricated price. All accounts must use one retained valuation currency. Current nongapped native SNAPSHOT bytes/hash/key, exact stored metadata/rule columns, effective/expiry times and native/received freshness are verified. The latest durable head is mandatory; caller selection or fallback to an older good head is forbidden.

Only available direct LAST prices are used. The smallest retained model age is capped at the server Risk ceiling of 5000ms. Freshness includes publication, ticker and book native/received times, not only receipt time. Exclusive result expiry also respects every rule expiry. At most 100 accounts, 1000 CREATED drafts, 300 unique markets, 3200 account-scoped prices and 1 MiB capture/calculation input; excess rejects wholly. Decimal calculations and durable revisions remain strings, with no rounding through Number.

The immutable **PAPER_RISK_VALUATION_SOURCE** includes complete inventory, pure valuation, current market IDs/head revisions/hashes/rule IDs and a stable content identity. Historical snapshotAt remains historical. A hash or serialized source is not a certificate, grant, reservation, permission or durable loss baseline. The source has no financial effect.

## Verification and remaining scope

After correcting the initial test ticker shape to ObservedPrice, all 22 corrected decoder contracts executed RED against the missing-source stub; implementation was restored and they passed GREEN. Six deployment-override cases and two physical hung-authentication abort/deadline cases also pass. Native tests cover actual durable prices, complete books, replay/restart, new prices, ambiguity, missing/stale/GAP/rule replacement/UNKNOWN/sibling failures, no source injection, lost COMMIT, hung locks/slots/close and role replacement. Fresh/native owner/populated published-43 upgrade, full regression and all required CI are mandatory before acceptance; results are recorded only after execution in [verification](verification.md).

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**. Certified PAPER Risk still needs current policies, controls/health, capabilities, intent and full exposure coverage, proven UTC loss/opening/high-watermark with external flows, atomic reservations/active holds and final dispatch validation. Current public prices cannot reconstruct unobserved historical seed valuations or a missing UTC loss journal. Missing evidence must deny certification; no zero baseline is inferred. Virtual execution/shared liquidity, conditional exits, positions/PnL/reset and public-feed recovery remain outstanding. LIVE/PAPER dispatch/positive native collateral credit remain disabled; native AMEND remains Binance Spot TESTNET only. Real private exchange tests and production soak are not claimed.
