# ExchangeAdapter и совместимость

Проверка источников: **2026-09-05**. Матрица описывает API бирж, не реализованный код. «Да» не гарантирует доступность конкретному региону/аккаунту. Подробные источники, URL, подписи, ограничения и противоречия: [Binance](phase-0/exchanges/binance.md), [Bybit](phase-0/exchanges/bybit.md), [OKX](phase-0/exchanges/okx.md), [HTX](phase-0/exchanges/htx.md).

## Матрица

Обозначения: S — обычный Spot, P — perpetual, F — срочный futures; условно — зависит от продукта/счёта. Возможности из legacy HTX требуют повторной проверки нового portal перед интеграцией.

| Возможность         | Binance                                                    | Bybit                                            | OKX                                   | HTX                                               |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------ | ------------------------------------- | ------------------------------------------------- |
| Spot                | Да                                                         | Да                                               | Да                                    | Да                                                |
| Futures / Perpetual | P USD-M; F/COIN-M отдельно от первого адаптера             | P/F, linear/inverse                              | SWAP/FUTURES                          | P/F, отдельные product APIs                       |
| Demo / Testnet      | Spot: Testnet и отдельный Demo; USD-M testnet/demo профиль | Раздельные Testnet и Demo, whitelist API         | Demo, отдельные ключи/header/WS       | Spot Testnet stopped; derivatives demo unverified |
| REST                | Да                                                         | V5                                               | V5                                    | Endpoint-specific V1/V2/V3/V5                     |
| WS market data      | Да                                                         | Да                                               | Да, public/business                   | Да                                                |
| WS private data     | Да; Spot WS API, P user stream                             | Да                                               | Да, private/business                  | Да                                                |
| Market orders       | S/P                                                        | S/P                                              | S/P                                   | S/P, проверить account version                    |
| Limit orders        | S/P                                                        | S/P                                              | S/P                                   | S/P                                               |
| Stop orders         | S conditional; P algo                                      | S/P conditional                                  | Algo, scope региональный              | Spot stop-limit/conditional, P trigger            |
| TP/SL               | S order lists; P algo                                      | S с условиями; P position TP/SL                  | Algo/attached с ограничениями         | Conditional / P TP-SL                             |
| Trailing stop       | S BIPS; P algo                                             | P position; S unverified                         | Algo, scope региональный              | Legacy S/P documented                             |
| Hedge mode          | P account-wide; S N/A                                      | P зависит от account/product, docs противоречивы | Derivatives long/short; portfolio net | P; semantics offset/reduce_only                   |

Подтверждения по каждой бирже и строкам находятся в исследованиях выше. Нельзя использовать эту обзорную таблицу как runtime permissions. Internal PAPER доступен архитектурно всем источникам public data; его fill model не называется официальным demo.

## Контракт профиля и capabilities

`AdapterProfile` immutable: `exchange`, `region`, `market`, `environment=LIVE|TESTNET|DEMO`, `accountMode`, `profileVersion`, server-controlled `endpointProfileId`, `credentialRef?`. PAPER/BACKTEST используют отдельный ExecutionPort без private exchange profile. `connectionId` закреплён за tenant, external account UID и средой; повторное подключение одного account не создаёт независимый risk/rate budget.

Capability record: `feature`, `support=SUPPORTED|UNSUPPORTED|UNVERIFIED`, `implementation=NATIVE|SYNTHETIC`, `constraints`, `evidenceUrl`, `checkedAt`, `expiresAt`, `adapterVersion`. Unknown и просроченные capabilities запрещают операцию; синтетическая возможность никогда не выдаётся за native. Capability server-side и UI используют один read model. Demo metadata хранится отдельно даже при одинаковом symbol.

Отдельные features: public/private streams, market/limit, quote-budget market buy, trigger, stop-limit, OCO, attached TP/SL, trailing, reduce-only, close-position, amend, leverage, position-mode, lookup-by-client-id, algorithmic orders, supported timeframes. Account mode change требует подтверждения, отсутствия конфликтующих позиций/заявок и последующего reconciliation.

## Нормализованные типы

Это проект DTO, не исходный TypeScript. В PHASE 4 каждое поле получает strict тип и runtime schema; денежный ввод проверяется до конструирования branded decimal type.

| Тип                       | Обязательная семантика                                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ExchangeId / MarketType   | BINANCE/BYBIT/OKX/HTX; SPOT/LINEAR_PERPETUAL/INVERSE_PERPETUAL/LINEAR_FUTURE/INVERSE_FUTURE                                                                                                                                                  |
| Instrument / Symbol       | Стабильный instrumentId; exchangeSymbol, normalized display symbol, base/quote/settlement, contractType/expiry, contractSize/unit, status, metadataVersion, environment                                                                      |
| TradingRules              | tickSize, stepSize, min/max quantity/notional, market-specific limits, supported order types, price bands, leverage tiers; precision отдельно от шага                                                                                        |
| Ticker                    | instrumentId, last/bid/ask, volumes, change, exchangeTime, receivedAt, freshness                                                                                                                                                             |
| TradeTick                 | tradeId или явно описанный identity scope, price, quantity/unit, side, exchangeTime, receivedAt, sourceSequence?                                                                                                                             |
| Candle                    | exchange, instrument, timeframe, UTC openTime/closeTime, OHLC, baseVolume, quoteVolume?, numberOfTrades?, complete, quality, revision, provenance                                                                                            |
| OrderBook                 | bids/asks decimal levels, snapshot/delta, source sequence/checksum где доступны, snapshotVersion, stale flag                                                                                                                                 |
| Balance / AccountSnapshot | external account scope, asset, free/locked/total, source version, timestamp/freshness; margin/availableToTrade не подменяются free                                                                                                           |
| Position                  | tenant, account, mode, instrument, LONG/SHORT/NET, quantity/unit, entryPrice, margin mode, leverage, liquidationPrice?, realized/unrealized PnL, version                                                                                     |
| Order                     | internalOrderId, intentId, clientOrderId, exchangeOrderId?, userId, connectionId, exchange, instrument, market, mode, side, type, status, price?, stopPrice?, quantity/unit, filledQuantity, averageFillPrice?, fees[], createdAt, updatedAt |
| AlgoOrder                 | internalAlgoId, clientAlgoId, exchangeAlgoId?, trigger source/price, childOrderIds, state; regular exchange ID не заменяет algo ID                                                                                                           |
| Fill / Fee / Funding      | Immutable execution identity, order/account/instrument, qty/price/unit, комиссия amount+asset+kind, funding timestamp/amount/asset; отрицательная комиссия допустима как rebate                                                              |
| Page<T> / Cursor          | Ограниченный список, opaque nextCursor; cursor закреплён за фильтром/account                                                                                                                                                                 |
| ExchangeError             | Классификация, sanitized code, retryAfter?, requestId; без secret, raw body и user-facing stack                                                                                                                                              |

Неизвестное числовое поле — null/unavailable с причиной, не ноль. Баланс и цена из разных моментов не обозначаются атомарным snapshot. На сетевой границе decimal и большие exchange IDs — строки; timestamp `number` допускается только после проверки safe integer и единицы.

## Методы ExchangeAdapter

В таблице `Result<T>` — типизированный результат; ошибки чтения не приравниваются к «пусто». `RequestContext` содержит deadline, AbortSignal, correlationId и назначенный limiter scope; tenant берётся из доверенного server context. Ни один метод не принимает произвольный URL или raw credentials.

| Группа               | Проект сигнатуры                                                                                                                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle            | `connect(context): Promise<Result<ConnectionHealth>>`; `disconnect(): Promise<void>`; `testConnection(context): Promise<Result<ConnectionReport>>`; `getServerTime(context): Promise<Result<ExchangeTime>>`                                          |
| Account              | `getAccountInfo(context): Promise<Result<AccountInfo>>`; `getBalances(query, context): Promise<Result<AccountSnapshot>>`; `getPositions(query, context): Promise<Result<Page<Position>>>`                                                            |
| Orders               | `getOpenOrders(query, context): Promise<Result<Page<Order>>>`; `getOrder(locator, context): Promise<Result<OrderLookup>>`; `getOrderHistory(query, context): Promise<Result<Page<Order>>>`; `getTrades(query, context): Promise<Result<Page<Fill>>>` |
| Instruments          | `getSymbols(query, context): Promise<Result<Page<Instrument>>>`; `getSymbolInfo(instrumentId, context): Promise<Result<Instrument>>`                                                                                                                 |
| Public reads         | `getTicker(instrumentId, context): Promise<Result<Ticker>>`; `getOrderBook(query, context): Promise<Result<OrderBook>>`; `getHistoricalCandles(query, context): Promise<Result<Page<Candle>>>`                                                       |
| Public streams       | `subscribeTicker`, `subscribeTrades`, `subscribeOrderBook`, `subscribeCandles`: `(request, context): Promise<Result<Subscription<TypedEvent>>>`                                                                                                      |
| Private streams      | `subscribePrivateOrders`, `subscribePositions`, `subscribeBalances`: `(request, context): Promise<Result<Subscription<TypedPrivateEvent>>>`                                                                                                          |
| Mutations            | `createOrder(authorizedCommand, context): Promise<SubmissionOutcome>`; `cancelOrder(authorizedCancel, context): Promise<MutationOutcome>`; `cancelAllOrders(authorizedScope, context): Promise<BatchOutcome>`                                        |
| Conditional features | `amendOrder`, `setLeverage`, `changePositionMode` возвращают `Result` или mutation outcome по семантике; capability отсутствует → UNSUPPORTED до сети                                                                                                |
| Algo lifecycle       | `createAlgoOrder`, `getAlgoOrder`, `cancelAlgoOrder`, `getAlgoHistory`, `subscribeAlgoOrders`; раздельные IDs и parent/child связь                                                                                                                   |

`Subscription<T>` имеет bounded `AsyncIterable<T>`, unsubscribe, health/status, loss/resync event. Каждое `T` конкретно для метода; union не позволяет ticker попасть в обработчик fill. Query для каждой операции имеет отдельную schema, allowlist фильтров и pagination. Abort прекращает ожидание/чтение, но не объявляет уже отправленный order отменённым.

`OrderLookup = FOUND(order) | NOT_FOUND_WITH_SCOPE(window, queriedIds) | INDETERMINATE(reason)`. `SubmissionOutcome = ACCEPTED(ack) | DEFINITIVELY_REJECTED(reason) | UNKNOWN(evidence)`. ACK подтверждает приём, не fill. Batch возвращает outcome каждой команды; общий HTTP 200 не означает успех всех ордеров.

`OrderSize` — discriminated union: `BASE_QUANTITY(value, asset)` / `QUOTE_BUDGET(value, asset)` / `CONTRACTS(value, contractSpecVersion)`. Limit требует limitPrice; trigger требует trigger source и price; неподдерживаемые комбинации отклоняются. Нельзя незаметно преобразовать market в иной order type без документированной семантики и slippage bounds.

`AuthorizedCommand` создаёт только execution service после durable RiskDecision и reservation. Тип не является security boundary: signer повторно проверяет persisted command hash, destination, dispatch attempt и permit expiry. Adapter не разрешает стратегическим modules непосредственный import private mutation implementation.

## Rate Limit Manager

Контракт: `reserve(operationCost, scopes, priority, deadline)` и `observeResponse(headers, code, observedAt)`. Один запрос атомарно резервирует все пересекающиеся бюджеты: egress-IP, UID, endpoint, symbol/instrument, REST/WS shared и WS connect/control. Redis Lua либо назначенный coordinator; локальный limiter не защищает несколько реплик. Redis cluster размещение совместимых ключей задаётся явно; нельзя делать неатомарный multi-key decrement через разные shards.

Weighted token bucket используется там, где соответствует модели биржи; fixed/sliding window добавляется для её календарных/скользящих квот. При неизвестной квоте, lost limiter state или failover новые рискованные операции останавливаются до безопасного восстановления бюджета/окна. Не обнулять счётчики на каждую новую реплику.

Приоритеты: emergency cancel → verified risk close → order management → account sync → manual → strategy → history → analytics. Резерв под cancel не обходит exchange hard limit; fairness предотвращает бесконечный голод reconciliation. Queue bounded, очередь исторических запросов не блокирует emergency lane. Quotas берутся из профиля, metadata и headers; dated numbers из исследования служат начальной справкой.

## Контрактные тесты PHASE 4–8

Fixtures с provenance официальной схемы; schema mismatch; signature byte-for-byte, timestamp/recvWindow, pagination, non-power-of-ten step, quote/base/contracts, regional/demo separation. WS: auth failure, ACK errors, gzip limits, heartbeat, malformed frames, reconnect, duplicate/out-of-order и source-specific book reset. Placement: accepted response lost, definite reject vs unknown, expired client lookup window, partial batch, ordinary/algo mapping, cancel/fill race. Network retries отключены для mutations на всех уровнях HTTP/queue/SDK; read retry ограничен budget/deadline.
