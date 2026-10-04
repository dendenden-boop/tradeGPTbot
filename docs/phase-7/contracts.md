# PHASE 7 — OKX contracts

The [Exchange Core contracts](../phase-4/contracts.md) and [requirements](requirements.md) remain authoritative. The factory implements the existing 33-operation interface. An unavailable feature returns UNSUPPORTED; no synthetic exchange operation is substituted. Acceptance remains IN PROGRESS until full regression and CI finish.

## Trusted composition and profiles

Only `createOkxAdapter` is a production runtime export. The strict factory accepts four server profile IDs, selected symbols, bounded capability evidence, rate limiter, optional scoped connection/credentials/permissions/authorization/Demo grant/identities/order admission/registry, server SWAP tradeMode and clock. No destination, raw credential or request authority is accepted. There is no default authorizer or I/O on construction.

Profiles: `okx-{spot,swap}-{live,demo}-v1`. Global REST is openapi.okx.com; Demo sends x-simulated-trading=1 on all requests. Public/private/business WS use ws.okx.com or wspap.okx.com on TLS443. No TESTNET, regional fallback or alternate host. LIVE reads may be admitted by fresh capabilities; every LIVE mutation is denied before private authorization/dispatch. Demo writes additionally require Core authorization/command hash, a trusted authorization port, explicit Demo acceptance grant and complete admission for createOrder.

Credentials carry the exact profile/account binding and passphrase. Signing occurs after atomic rate reservation and fresh trusted permission proof. REST signs ISO millisecond UTC timestamp + uppercase method + exact escaped path/query + exact JSON body (empty body for GET), Base64 HMAC SHA256. WS login signs epoch seconds + GET/users/self/verify and includes native apiKey/passphrase/timestamp/sign. Clock sample is at most 30s old, RTT at most 1s and offset at most 500ms. Permission enrollment proof is at most 30s old, non-withdrawal and bound to profile/account/reference. POST signing additionally requires fresh trade permission.

Native account/config is additional evidence, never a substitute for enrollment or Risk: exactly one matching uid, acctLv=2, net_mode, autoLoan=false, regular roleType/spotRoleType/stgyType, read_only and optional trade, no withdraw or unknown permission. Private reads/mutations and each new private subscription fetch it afresh. Missing or incompatible evidence fails closed. Spot uses cash; SWAP cross/isolated is server controlled. Account mode switching, borrowing, hedge, portfolio, dated/inverse/equity contracts and other quotes are outside scope.

## Native data and admission

Lossless JSON retains source number tokens as text. Financial arithmetic never uses Number; timestamps and bounded integer controls use safe integers. DTOs pass Core schemas and immutable boundaries.

| Native value                                      | Common contract                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spot lotSz/minSz/maxLmtSz                         | BASE quantity rules                                                                                                                                |
| Spot maxMktSz                                     | USDT constraint, never BASE; local BASE market cap is additional maxLmtSz                                                                          |
| SWAP sz/accFillSz/fillSz/pos                      | CONTRACTS; explicit contractSpecVersion, linear ctVal BASE, ctMult=1                                                                               |
| SWAP book quantities                              | BASE = native contracts × ctVal; no implicit order size conversion                                                                                 |
| Candle nine-column vol/volCcy/volCcyQuote/confirm | BASE volume (Spot vol, SWAP volCcy), quote observation, explicit complete flag; half-open UTC time bounds                                          |
| Spot vol24h/volCcy24h                             | BASE / quote 24h volume                                                                                                                            |
| SWAP volCcy24h                                    | BASE 24h volume; quote 24h observation unavailable                                                                                                 |
| Wallet cashBal/availBal/frozenBal                 | total / observed available / locked; free unknown, no USD equity as coin balance; liabilities unsupported                                          |
| NET pos/mgnMode/lever/uTime                       | signed contracts / exact selected margin mode / native leverage / version                                                                          |
| Execution billId/fillTime/fee                     | scoped durable fill identity / actual execution timestamp / negative native charge becomes positive common fee; positive native fee becomes rebate |

Instruments and rules expire within 60s, earlier at announced upcChg effTime. A unique observation participates in the metadata version; rules cannot be silently renewed or changed under an existing version. Registry/cached versions must agree before dispatch. Unknown top-level fields, unknown upcChg members/parameters and new nested shapes inside known scalar/list fields block new-risk admission. They are not silently cast to primitive constraints.

The actual Demo Spot response captured on 2026-10-04 has empty maxMktSz and extra fields (`freq`, `method`, `posLmtAmt`, `posLmtPct`, `maxPlatOILmt`, `maxPlatOICoinLmt`, `longPosRemainingQuota`, `shortPosRemainingQuota`). It remains publicly readable, with unsupported admission recorded explicitly. These fields are not auto-whitelisted from a sample. New-risk dispatch for that metadata stays UNSUPPORTED until its complete semantics and fresh native/Risk limits are proved. This is a trading limitation, not a public connectivity failure.

The order admission port must verify full native notional, price bands, liquidity/slippage and current Risk evidence. No-op/missing admission is not a production implementation. Spot market sends tgtCcy=base_ccy, banAmend=true and tradeQuoteCcy=USDT; size reduction/conversion is forbidden. Limits map GTC/IOC/FOK/POST_ONLY to limit/ioc/fok/post_only, pxAmendType=0. SWAP reduceOnly remains NET only. Client IDs are 1–32 alphanumeric characters.

Ordinary ordId/clOrdId cannot resolve algoId/algoClOrdId or attached algo orders. Native scope/mode/algo checks precede identity resolution. Existing Core createAlgoOrder single-trigger immediate-child contract is unchanged; OKX algo, triggers, attached TP/SL, OCO, trailing, amend and close-position features are explicitly unsupported.

## Mutation uncertainty and pagination

Native HTTP and top code are not sufficient ACK evidence: exactly one receipt with successful sCode, valid ordinary ordId and matching submitted ID is required. Leverage ACK must match native instrument/margin/lever/NET receipt. A small documented validation-code allowlist (51000/51001/51006/51008) is definitively rejected. Everything ambiguous after dispatch—HTTP error, timeout, connection loss, 50004, duplicate/not-found outcome, unknown code, malformed/mismatched receipt—returns UNKNOWN. There is no mutation retry. Core retains durable dispatch state; recovery reads by stable client ID. Native empty/51603 lookup is INDETERMINATE, never authoritative absence.

Create expTime header is bounded by the request and permit deadlines; it prevents late processing, not a later order cancel. Permission, permit, rules and admission are rechecked immediately before dispatch. Cancel batches dispatch individually authorized ordinary commands. Cancel and leverage cannot inherit unknown success from an empty response.

Private cursors are opaque Core query-bound continuations over native after ordId/billId, at most 100 rows and 7-day history request windows. Native IDs must progress strictly, with no duplicate rows. At most 16 live/pending initial continuations; no eviction. A continuation has one consumer, a non-renewable five-minute expiry and is deleted immediately on terminal page. Fully consumed cursors free slots immediately. Public instrument pages bind to a unique metadata lease; history uses exclusive after/before bounds and UTC daily bars. Maximum accepted candle page is 100, book depth 400.

## Lifetime, streams and integration boundary

Real IO caps body 2MiB, headers 16KiB, 16 HTTP operations, WS output buffer 64KiB and operation deadline 30s. Abort/deadline destroy underlying sockets, with 250ms close grace; the transport promise actually settles. Core pending slots release only after settlement. Trusted ports are bounded by signal/deadline. Redirects/retries are absent. Atomic server rate budgets cover shared egress IP, UID, instrument type, endpoint, connections and control messages. Native 403/429 and 50011/50040 establish local backoff before observer settlement; headers are observed even for malformed envelopes.

WS login and subscribe ACK precede DATA; pre-ACK data is bounded to 16 frames/1MiB. Tickers/trades/books use public WS, candles use business WS, private orders/positions require fresh config/login. Native string ping/pong has a 20s cadence and consumes control budget. At most 16 sources, each explicitly closed on abort/deadline/disconnect. A source loss, upgrade notice, wrong channel/scope, malformed/regressing observation or missing ACK causes terminal resync/closure.

Books require actual prevSeqId linkage. Native maintenance sequence reset is allowed when previous linkage matches; no invented seq+1 rule. Zero-size updates delete levels, conflicting same-sequence data fails. Deprecated checksum=0 is not integrity evidence. Private duplicates are normalized once; regressions in timestamp/fill/terminal status require resync. Private order cache is bounded to 64 without eviction. Re-authentication is required for a new subscription after source close; automatic reconnect/backfill orchestration remains PHASE 9. Wallet delta and algo streams are unsupported.

Tests distinguish fixtures from actual loopback HTTP/WS and public-only exchange probes. No account credentials/grant were provided: real private reads/writes are NOT RUN. No API/database writer, migration, live trading or later phase is introduced.
