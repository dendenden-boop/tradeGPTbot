# PHASE 5 — Контракты Binance Adapter

Контракт реализован в `@ctp/exchange-binance`; база — [Exchange Core](../phase-4/contracts.md). Статус acceptance и точное evidence находятся в [verification](verification.md). Пакет не подключён к API и не предоставляет разрешение на торговлю.

## Общая семантика algo

`createAlgoOrder` содержит ровно один внешний `trigger`. Его срабатывание активирует child `MARKET` или `LIMIT`; `child.trigger` всегда null. `STOP_MARKET`/`STOP_LIMIT` внутри child запрещены до authorization и transport. Двухступенчатого ожидания trigger в этом контракте нет. Это общее правило Exchange Core для Binance/Bybit/OKX/HTX, а не скрытая интерпретация Binance serializer.

Нативная активация не гарантирует fill; LIMIT child после trigger может остаться открытым. Algo ID и ID созданного обычного child различаются. Чтение/отмена/reconciliation должны сохранять эту связь. Source LAST/MARK/INDEX включается только если конкретный профиль поддерживает соответствующий native source.

Общий STOP comparator: BUY активируется при наблюдаемой цене ≥ trigger.price, SELL — при цене ≤ trigger.price. TAKE_PROFIT с обратным направлением не подразумевается. Это правило относится к самостоятельным STOP_* и общему createAlgoOrder на всех биржах.

USD-M native algo принимает clientAlgoId, но не позволяет назначить clientOrderId сгенерированного child. Адаптер не игнорирует запрошенный child clientOrderId: generic createAlgoOrder остаётся UNSUPPORTED до явного общего контракта идентичности native child. Spot order lists также не подменяют этот algo contract. Quote-budget market buy с неизвестной исходной BASE quantity не объявляется поддерживаемым в текущей Order schema.

Баланс derivatives хранит сообщённый wallet balance в total и сообщённый availableBalance в availableToTrade. free/locked равны null, если биржа не сообщает эти составляющие. availableBalance может превышать wallet balance из-за PnL; вычитание не используется для выдуманного locked. Spot сохраняет фактические free/locked. OrderBook.exchangeTime может быть null для Spot depth без timestamp; execution timestamps остаются обязательными.

## Transport boundary

Общий adapter использует server-controlled endpoint profile и credentials port; operation input не содержит URL/key/secret/tenant authority. HTTP(S) не следует redirects и не повторяет mutations. AbortSignal/deadline завершают локальную сетевую работу, уничтожая request/socket; это не доказывает отмену операции на стороне Binance. После возможного dispatch исход остаётся UNKNOWN до reconciliation.

Для WS graceful close имеет конечный budget с принудительным terminate. Handshake и pending HTTP ограничены deadline даже при отсутствии ответа. Core pending slot освобождается только после settling transport promise; тесты должны наблюдать как результат Promise, так и закрытие локальных sockets. Protocol ACK, private authentication и gap обрабатываются над этим IO boundary.

Rate admission и durable mutation authorization остаются отдельными обязательными server ports. Test ports не регистрируются в production API. Настоящий sandbox mutation требует отдельного account/profile-scoped acceptance grant; LIVE dispatch всегда запрещён.

## Endpoint profiles

Идентификаторы имеют prefix `binance-` и suffix `-v1`. Environment/account mode входят в scope capability, account и cursor; scope нельзя перенести между профилями.

| Profile        | REST host                | Public WS                                    | Private WS                                | Market / account mode      |
| -------------- | ------------------------ | -------------------------------------------- | ----------------------------------------- | -------------------------- |
| `spot-live`    | `api.binance.com`        | `stream.binance.com:443`                     | `ws-api.binance.com:443/ws-api/v3`        | SPOT / SPOT                |
| `spot-testnet` | `testnet.binance.vision` | `stream.testnet.binance.vision`              | `ws-api.testnet.binance.vision/ws-api/v3` | SPOT / SPOT                |
| `spot-demo`    | `demo-api.binance.com`   | `demo-stream.binance.com`                    | `demo-ws-api.binance.com/ws-api/v3`       | SPOT / SPOT                |
| `usdm-live`    | `fapi.binance.com`       | `fstream.binance.com/public`, `/market`      | `fstream.binance.com/private`             | LINEAR_PERPETUAL / ONE_WAY |
| `usdm-testnet` | `demo-fapi.binance.com`  | `demo-fstream.binance.com/public`, `/market` | UNSUPPORTED                               | LINEAR_PERPETUAL / ONE_WAY |

REST использует HTTPS, WS — WSS. У USD-M TESTNET строка private URL присутствует во внутреннем профиле, но routing не подтверждён: capability принудительно UNSUPPORTED и сетевой вызов запрещён. Имя endpoint profile не доказывает live acceptance аккаунта. Для USD-M нет отдельного DEMO alias. Regional fallback, COIN-M, dated futures, HEDGE, Portfolio Margin и margin account отсутствуют.

## Операции и capabilities

Любой вызов проходит общие schema/profile/account/metadata/deadline/capability gates Core. Таблица описывает реализованный протокол; caller обязан предоставить свежие native capability records. Пустые, UNKNOWN, просроченные либо несовместимые records не повышаются до SUPPORTED.

| Операции Core                                                                                 | Spot                                              | USD-M                                           | Ограничения                                                                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `testConnection`, `getServerTime`                                                             | ping/time; при account binding — signed account   | аналогично                                      | testConnection только читает permissions; canTrade не является authorization             |
| `getSymbols`, `getSymbolInfo`                                                                 | exchangeInfo                                      | exchangeInfo                                    | только server-selected universe; fresh registry observation                              |
| `getTicker`, `getOrderBook`, `getHistoricalCandles`                                           | ticker/24hr, depth, klines                        | те же native routes                             | строгие units, depth snapshot, `[from,to)`                                               |
| `subscribeTicker`, `subscribeTrades`, `subscribeCandles`                                      | ticker / aggTrade / kline                         | аналогично                                      | native timeframe, bounded lifetime, terminal gap                                         |
| `subscribeOrderBook`                                                                          | partial depth 5/10/20                             | partial depth 5/10/20                           | только SNAPSHOT; нет локальной diff-depth сборки                                         |
| `getAccountInfo`, `getBalances`                                                               | account                                           | account V2 + mode; balance V3                   | signed reads и точный server account binding                                             |
| `getPositions`                                                                                | пустая страница                                   | positionRisk V2                                 | genuine leverage/marginType; только ONE_WAY                                              |
| `getOpenOrders`, `getOrder`, `getOrderHistory`, `getTrades`                                   | openOrders/order/allOrders/myTrades               | openOrders/order/allOrders/userTrades           | scoped symbol; обязательный identity port для order/fill                                 |
| `subscribePrivateOrders`, `subscribeBalances`, `subscribePositions`                           | signed WS API subscription; positions неприменимы | listenKey stream на подтверждённом LIVE routing | TESTNET USD-M private stream UNSUPPORTED; события требуют fresh REST snapshot            |
| `createOrder`                                                                                 | BASE MARKET/LIMIT, STOP_MARKET/STOP_LIMIT LAST    | BASE MARKET/LIMIT, reduceOnly                   | только sandbox; complete dynamic admission; STOP USD-M UNSUPPORTED                       |
| `cancelOrder`, `cancelAllOrders`                                                              | DELETE order                                      | DELETE order                                    | batch — 1–100 явных авторизованных locators, не broad cancel всех ордеров аккаунта       |
| `setLeverage`                                                                                 | UNSUPPORTED                                       | POST leverage                                   | sandbox, целое 1–125, ONE_WAY                                                            |
| `amendOrder`, `changePositionMode`                                                            | UNSUPPORTED                                       | UNSUPPORTED                                     | native API не подменяет общий amendment contract                                         |
| `createAlgoOrder`, `getAlgoOrder`, `cancelAlgoOrder`, `getAlgoHistory`, `subscribeAlgoOrders` | UNSUPPORTED                                       | UNSUPPORTED                                     | child identity mismatch описан выше; serializer fixtures не являются поддержкой endpoint |

Дополнительно принудительно UNSUPPORTED: OCO, attached TP/SL, trailing stop, closePosition, quote-budget market buy. Spot POST_ONLY сериализуется LIMIT_MAKER; USD-M — GTX. Никакой capability не включает отсутствующую реализацию. Документированная native возможность Binance не означает её поддержку общим DTO.

## Instruments и точность

Spot допускает TRADING + isSpotTradingAllowed; USD-M — TRADING, PERPETUAL, USDT quote/margin. Factory universe ограничен 1–300 уникальными uppercase ASCII symbols, суммарным JSON размером 8192 байта. Это предел конфигурации, а не подтверждение нагрузки 300 subscriptions.

PRICE_FILTER, LOT_SIZE, MARKET_LOT_SIZE и notional filters сохраняют native tick/step/min/max. Precision не используется вместо step. USD-M quantity выражена в BASE, contractSize 1 BASE задаёт размерность linear модели, а не выдуманное exchangeInfo поле. CONTRACTS quantity не поддерживается. Неизвестные filters блокируют новый риск; dynamic/account filters, percent-price, market valuation и account budgets проверяет обязательный server orderAdmission port.

Numeric JSON tokens читаются из исходного token source Node 24 без промежуточной потери numeric ID. Money — канонические decimal strings в пределах Core/storage contracts; float/exponent/NaN/-0 и превышение bounds отклоняются. Timestamp исполнения обязателен; Spot depth без native timestamp имеет exchangeTime=null. USD-M недоступные bid/ask остаются UNAVAILABLE.

Metadata lease — 60 секунд. Каждая фактическая exchangeInfo observation получает отдельные metadata/rules versions и lease ID, включая A→B→A при одинаковом времени. Экономический contractSpecVersion стабилен для одинаковой спецификации. Cached universe и точные registry versions сверяются перед чтением и повторно непосредственно перед mutation dispatch. Отсутствующий/удалённый/stale инструмент не восстанавливается из старого registry record.

## Pagination и streams

Внешний cursor защищён Core HMAC/scope/expiry. Symbol cursor дополнительно привязан к конкретной observation lease, поэтому concurrent refresh не смешивает страницы даже в одной миллисекунде. Candles используют native UTC интервалы `1m,3m,5m,15m,30m,1h,4h,1d`; 30s UNSUPPORTED до PHASE 9. Binance inclusive close/endTime преобразуется в общий exclusive bound; out-of-window данные отвергаются.

Private pagination фиксирует immutable snapshot: максимум 16 snapshots, TTL 5 минут, до 999 native rows каждый. Ответ ровно в 1000 rows считается потенциально усечённым и возвращает BUSY; вызывающий сужает окно. History/fills window максимум 24 часа Spot / 7 дней USD-M. Сортировка same-ms fills включает точный numeric fill ID. Cursor привязан к operation, account/profile, instrument, queryId, window и limit. Обновлённый запрос не продолжает чужой snapshot.

Spot combined envelope и USD-M route проверяются строго. Partial-depth snapshot не является diff: Spot sourceSequence может прыгать, USD-M проверяет pu с предыдущим u. Malformed payload, sequence gap, stale REST refresh, queue overflow, abort/deadline завершают stream с terminal notification; автоматического retry/reconnect нет. Private event — dirty notification: order запрашивается по точному exchange ID, closed order не ищется только в openOrders. Для USD-M balance каждый изменённый asset обязан присутствовать и иметь updateTime≥event.T; свежесть другого asset не доказывает актуальность изменённого. Delta balance не выдаётся за полный account snapshot. Position refresh использует genuine V2 fields и timestamp проверки.

## Authentication, admission и UNKNOWN

Server connection port выдаёт immutable account и opaque credentialRef. Fresh credential resolver обязан вернуть точно тот же profile/account. Операционный tenantId — проверяемый scope, а не источник полномочий. Production entrypoint не экспортирует raw IO, signer или factoryWithIo; конфигурация strict и отклоняет URL/key/secret/testing fields.

REST HMAC-SHA256 подписывает точные URLSearchParams bytes; signature последняя, ключ передаётся X-MBX-APIKEY. Spot WS использует `userDataStream.subscribe.signature` с отсортированными ASCII parameters, без deprecated Spot listenKey. USD-M listenKey создаётся только для подтверждённого private routing. Credentials не попадают в public errors/causes/report; приватные exchange messages не копируются в ошибки.

Перед private request обновляется server clock. Sample RTT≤1000 мс, age≤30 секунд, midpoint correction≤500 мс; recvWindow=5000 мс. REST signature готовится после rate reservation, WS signature после handshake/control admission. Это предотвращает устаревший timestamp из-за очереди. Все async server ports ограничены тем же signal/deadline; позднее completion не запускает IO.

Mutations требуют durable Core permit/hash + server authorizer + отдельный account/profile-scoped sandbox grant; createOrder также complete orderAdmission. После всех await повторно проверяются metadata/rules/admission fingerprint/expiry. LIVE запрещён независимо от capabilities и разрешений API key. Отказ до dispatch возвращает REJECTED/соответствующий error; после dispatch network loss, timeout, ambiguous 5xx/-1006/-1007/duplicate outcome и malformed ACK возвращают UNKNOWN. Подтверждённые parameter/auth reject могут быть definitive. ACK не является fill.

Reconciliation выполняется отдельным read по exchangeOrderId или clientOrderId. Native -2013 даёт INDETERMINATE/NOT_AUTHORITATIVE; отсутствие в snapshot не доказывает отсутствие исполнения и не разрешает повторный POST. Полный durable recovery engine относится к PHASE 11, Risk Engine — к PHASE 12.

## Resource bounds и rate admission

Core и IO удерживают до 16 pending requests/16 sockets. Transport deadline максимум 30 секунд по wall clock; HTTP body≤2 MiB, headers≤16 KiB, WS message≤1 MiB, compression выключена. Outgoing WS queue≤16 сообщений, buffered bytes≤64 KiB. Close grace≤250 мс, далее destroy/terminate; hang headers/body/handshake/peer-close имеет конечный lifecycle. Private refresh queue≤16, concurrency=1, dedup history≤64. Весь adapter disconnect идемпотентно завершает public/private sockets и network IO.

Mandatory limiter.reserve/observe получает profile/account/route/method/symbol и отдельные weight/orders/connectionAttempts/controlMessages. Реальный server limiter должен атомарно согласовывать бюджеты общего egress IP, аккаунта и endpoint; локальный permissive test port не является production limiter. HTTP response rate headers и WS ACK counters/RetryAfter передаются observer. 429/418 устанавливают bounded local backoff (1–86400 секунд; default 60), но не повторяют вызов. Redirects, host rotation и региональные обходы отсутствуют.

## Первичные источники

Protocol research сверялся 1–2 октября 2026; fixtures и фактическое external evidence перечислены отдельно в verification. Публичная документация не доказывает доступность конкретного приватного аккаунта.

- [Spot REST: errors, signing, timing, limits](https://developers.binance.com/en/docs/products/spot/rest-api).
- [Официальный Spot REST reference и filters](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md), [filters](https://github.com/binance/binance-spot-api-docs/blob/master/filters.md).
- [Spot signed user-data subscriptions](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/ws-api/user-data-stream), [Spot streams](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md).
- [USD-M general information](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info), [native trade/algo parameters](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade).
- [USD-M market data](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data), [market streams](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market).
