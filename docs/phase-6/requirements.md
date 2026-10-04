# PHASE 6 — Bybit Adapter: требования

Baseline: clean main `c6fa349afe40e37466c9c0ba88af24824220b6da`, совпадает с origin/main. [PHASE 5 acceptance](../phase-5/verification.md), [Core contracts](../phase-4/contracts.md) и [roadmap](../phase-0/implementation-plan.md) прочитаны. Baseline local format/docs/lint/typecheck/unit/HTTP/build/schema/runtime/clean/audit выполнен до изменений; точные результаты — [verification](verification.md).

## Scope

Самостоятельный `@ctp/exchange-bybit`: Bybit V5, global profiles Spot и USDT linear perpetual, UTA 2.0/Pro (unifiedMarginStatus 5/6), cross/isolated, только one-way. LIVE, TESTNET и Mainnet DEMO — разные immutable server profiles. Demo public WS берётся с mainnet, private REST/WS — только demo. Regional domains, UTA 1/classic, Portfolio Margin, inverse/dated/USDC, prelisting, xstocks и Hedge не включаются без отдельной приёмки.

Порядок: public REST и instruments/rules → public WS → scoped private authentication/account/balances/orders/fills/positions → sandbox mutation protocol. Отдельные requirements/contracts/verification и полный CI обязательны; PHASE 7 не начинается до acceptance. API composition, DB writers/migrations, Risk/Order/Portfolio/Market Data engines не входят в эту фазу.

## Обязательные invariants

- Factory принимает только profile ID, bounded symbols, dated capability evidence и trusted server ports. User URL, raw credentials и account/tenant hints не дают полномочий; io/signer/test assembly не экспортируются.
- Реальный Node HTTP/WS соблюдает abort/deadline, уничтожает hung sockets за конечное время, удерживает slots до settling. Все credential/rate/authorization/admission/permission ports имеют тот же bounded lifecycle; late completion не запускает dispatch.
- HMAC подписывает точные GET query / POST JSON bytes после limiter reservation. Clock sample только из выбранного endpoint, RTT/age/skew ограничены. Private WS подписывает `GET/realtime{expires}` после handshake/control admission.
- Durable Core permit, trusted authorizer, account/profile sandbox grant, fresh permission evidence и complete orderAdmission обязательны. Никаких LIVE mutations независимо от одобрения ports. Реальные TESTNET/DEMO mutations без отдельного account scope не выполняются.
- ACCOUNT_READ не доказывает TRADE. Permission port предоставляет свежую server-verified UID/profile/key-version evidence, включая отсутствие withdrawal; отсутствующая/непроверенная evidence блокирует private access/mutations. Demo не вызывает отсутствующий в её whitelist `/v5/user/query-api`. Native account info дополнительно проверяет UTA/margin; linear position reads и mutations проверяют реальный positionIdx=0 выбранного symbol.
- ACK означает приём запроса, не fill/cancel completion. Timeout/connection loss/10000/10016/duplicate/malformed ACK после dispatch → UNKNOWN; нет blind retry POST. Read-only reconciliation по orderId/orderLinkId; empty delayed history/realtime → INDETERMINATE, не доказательство отсутствия исполнения.
- Spot MARKET всегда `marketUnit=baseCoin`, `isLeverage=0`; QUOTE_BUDGET не включается пока Core не может сохранить BASE quantity. CONTRACTS/stop/algo/TP-SL/trailing/amend/mode switch явно UNSUPPORTED в начальном scope; общий single-trigger contract PHASE 5 не меняется.
- Decimal strings и opaque IDs сохраняются без IEEE-754 rounding. Market/limit quantity limits различаются, deprecated Spot minOrderQty/maxOrderQty/maxOrderAmt не заменяют текущие constraints. Unknown constraint fields в price/lot/leverage/risk/instrument metadata блокируют new-risk admission; не превращаются в поддержанную семантику.
- Public WS book ждёт snapshot, применяет zero-delete deltas, reset u=1 только с новым snapshot; seq сравнивается по порядку без выдуманного seq+1. Gap/overflow/malformed/source close завершают stream с resync, не silent loss. Duplicate Filled при cancel/fill гонке не создаёт второй observation; terminal regression — gap. Нет ledger effects из WS.
- Wallet UNIFIED не выдумывает free/available из walletBalance, USD account totals не копируются в coin balances; spotBorrow учтён в net wallet. Wallet stream не выдаётся за complete snapshot (native wallet не даёт initial snapshot и не сигнализирует все PnL changes); capability ограничена.

## Acceptance

Contract tests до production source; real loopback HTTP/WS integration, signing vectors, six routing profiles, account/category/quantity/precision gates, unknown outcomes/reconciliation, duplicate/out-of-order events, abort/hung/slot reuse, rate headers/backoff, pagination capacity/cursor scope, secret-free errors, production export/deployment boundaries. Затем полный regression и существующий CI Windows/Linux/PostgreSQL/Redis/SMTP/Docker. Проверки без среды/credentials отмечаются NOT RUN; READY FOR PHASE 7 только после фактического полного CI.

Официальные источники сверяются 4 октября 2026: [guide](https://bybit-exchange.github.io/docs/v5/guide), [Demo](https://bybit-exchange.github.io/docs/v5/demo), [instruments](https://bybit-exchange.github.io/docs/v5/market/instrument), [orders](https://bybit-exchange.github.io/docs/v5/order/create-order), [account info](https://bybit-exchange.github.io/docs/v5/account/account-info), [wallet](https://bybit-exchange.github.io/docs/v5/account/wallet-balance), [WS connect](https://bybit-exchange.github.io/docs/v5/ws/connect), [private order](https://bybit-exchange.github.io/docs/v5/websocket/private/order), [rates](https://bybit-exchange.github.io/docs/v5/rate-limit), [errors](https://bybit-exchange.github.io/docs/v5/error).
