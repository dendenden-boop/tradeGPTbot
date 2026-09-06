# Bybit V5: проверка перед проектированием адаптера

Проверено **2026-09-05** по официальной документации Bybit. Область: Spot и perpetual; срочные futures отмечены отдельно. Это документальная проверка: авторизованные запросы, создание ордеров и проверка конкретного аккаунта не выполнялись. Значения ниже нельзя переносить на другой регион, account mode или environment без проверки.

## Среды и адреса

| Среда | REST base URL | Public WebSocket | Private WebSocket |
| --- | --- | --- | --- |
| Live, глобальный сайт | `https://api.bybit.com` | `wss://stream.bybit.com/v5/public/spot`, `wss://stream.bybit.com/v5/public/linear`, `wss://stream.bybit.com/v5/public/inverse` | `wss://stream.bybit.com/v5/private` |
| Testnet | `https://api-testnet.bybit.com` | `wss://stream-testnet.bybit.com/v5/public/spot`, `wss://stream-testnet.bybit.com/v5/public/linear`, `wss://stream-testnet.bybit.com/v5/public/inverse` | `wss://stream-testnet.bybit.com/v5/private` |
| Mainnet Demo | `https://api-demo.bybit.com` | Те же публичные потоки, что Live | `wss://stream-demo.bybit.com/v5/private` |

REST адреса и региональные исключения: [Integration Guidance](https://bybit-exchange.github.io/docs/v5/guide). WS адреса: [Connect](https://bybit-exchange.github.io/docs/v5/ws/connect). Demo — самостоятельный аккаунт с отдельным UID/ключом, созданный через переключение основного аккаунта в Demo Trading. Не смешивать с Testnet; Bybit прямо не рекомендует создавать ключ в Testnet Demo. Demo хранит ордера семь дней, лимиты не повышаются, поддерживается ограниченный список API, включая create/amend/cancel, позиции, leverage, switch-mode, trading-stop, баланс и private order/execution/position/wallet. [Demo Trading](https://bybit-exchange.github.io/docs/v5/demo).

WS order entry: `wss://stream.bybit.com/v5/trade` и `wss://stream-testnet.bybit.com/v5/trade`; Spot и контракты поддерживаются, **Demo не поддерживается**. Подтверждение приема create/amend/cancel не подтверждает исполнение. [WS Trade Guideline](https://bybit-exchange.github.io/docs/v5/websocket/trade/guideline).

## Матрица возможностей

| Возможность | Bybit: документально подтвержденная область |
| --- | --- |
| Spot | Да, `category=spot` |
| Perpetual / futures | Да; `linear`/`inverse`, тип контракта определять по Instrument Registry |
| Demo / Testnet | Официальные отдельные среды; Demo API ограничен whitelist |
| REST | Да, V5 |
| WS market data | Да, отдельные публичные каналы рынков |
| WS private data | Да, аутентифицированные account streams |
| Market / Limit | Да для Spot и контрактов |
| Stop | Условные ордера через `triggerPrice`; Spot различает `StopOrder` и `tpslOrder` |
| TP/SL | Да; Spot attachment поддерживается при создании Limit; для позиции есть trading-stop |
| Trailing stop | Подтвержден для позиции контрактов; Spot trailing через V5 в проверенных endpoint не подтвержден |
| Hedge mode | Да, с оговоркой об account/product scope ниже; для обычного Spot не применять модель двух контрактных позиций |

Основания для торговых типов: [Place Order](https://bybit-exchange.github.io/docs/v5/order/create-order); trailing/position TP-SL: [Set Trading Stop](https://bybit-exchange.github.io/docs/v5/position/trading-stop); среды и транспорт: источники выше. Доступность конкретного инструмента в Demo/Testnet требует discovery и последующего contract test.

## Подпись и состояние аккаунта

REST HMAC-SHA256: подписывается конкатенация `timestamp + apiKey + recvWindow + queryString` для GET либо `timestamp + apiKey + recvWindow + jsonBodyString` для POST. Результат HMAC — lowercase hex; RSA-SHA256 ключи используют base64. Передавать `X-BAPI-API-KEY`, `X-BAPI-TIMESTAMP`, `X-BAPI-SIGN`, `X-BAPI-RECV-WINDOW`; окно по умолчанию 5000 ms, условие `serverTime - recvWindow <= timestamp < serverTime + 1000`. Подписанные байты должны совпадать с отправленными. В пункте 3 руководства есть опечатка о заголовке подписи: перечень заголовков и примеры используют `X-BAPI-SIGN`. [Integration Guidance](https://bybit-exchange.github.io/docs/v5/guide).

Читать `GET /v5/account/info`: `unifiedMarginStatus`, `marginMode`; `spotHedgingStatus` не подменяет position mode контрактов. [Account Info](https://bybit-exchange.github.io/docs/v5/account/account-info).

**Неоднозначность hedge:** текущая таблица UTA2.0 утверждает one-way/hedge для USDT perpetual/futures, USDC perpetual, inverse perpetual/futures. Однако вводный текст ограничен USDT perpetual/inverse futures, а поле `category` у `POST /v5/position/switch-mode` описывает только `linear`, USDT Contract. Нельзя объявить автоматическое переключение всех контрактов проверенным. Для MVP — USDT perpetual; расширение после уточнения Bybit и contract tests. `mode=0/3`; приоритет symbol > coin > default, default one-way; массовое переключение по coin обходит инструменты с позициями/ордерами. [Switch Position Mode](https://bybit-exchange.github.io/docs/v5/position/position-mode).

Для leverage: `POST /v5/position/set-leverage`, `linear`/`inverse`; в one-way buy/sell leverage равны; hedge допускает разные в isolated, требует одинаковые в cross. [Set Leverage](https://bybit-exchange.github.io/docs/v5/position/leverage). Trailing задается расстоянием цены `trailingStop`, активация — `activePrice`; Full TP/SL — Market, Partial допускает Limit; одностороннее изменение может разорвать связь парных TP/SL. [Set Trading Stop](https://bybit-exchange.github.io/docs/v5/position/trading-stop).

## WebSocket: ограничения и восстановление

Public auth не нужен. Private HMAC auth: `op=auth`, `args=[apiKey, expires, signature]`, подпись строки `GET/realtime{expires}`; `expires` в будущем. Рекомендован `op=ping` каждые 20 s. Private/order-entry idle timeout по умолчанию 10 min; `max_active_time` 30–600 s. Subscription: `op=subscribe`, `args=[topic...]`; Spot — максимум 10 topics в одном subscribe, общий размер args на public connection ≤21000 символов; отдельного числового лимита Futures args страница не задает. [Connect](https://bybit-exchange.github.io/docs/v5/ws/connect).

Стакан начинается snapshot, затем delta; новый snapshot полностью заменяет локальный стакан, количество 0 удаляет уровень, `u=1` означает сброс после рестарта. `seq` сравнивает порядок разных глубин: правило последовательного `seq+1` не документировано. Решение проекта: после reconnect/потери данных помечать book stale и ждать нового snapshot. [Orderbook](https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook).

Нативные Kline начинаются с 1 min; 30 s строить из реальных сделок, пробелы маркировать. [Kline](https://bybit-exchange.github.io/docs/v5/market/kline). Поток `publicTrade.{symbol}` содержит trade ID и время; один пакет Spot/Futures может содержать до 1024 сделок, одинаковый `seq` допустим в нескольких пакетах. [Public Trade](https://bybit-exchange.github.io/docs/v5/websocket/public/trade).

## Rate limits: несколько независимых бюджетов

| Scope | Проверенное правило |
| --- | --- |
| REST IP | 600 запросов / 5 s; при 403 access-too-frequent остановить HTTP минимум на 10 min |
| WS connect IP | ≤500 подключений / 5 min; ≤1000 одновременных market-data connections отдельно для Spot/Linear/Inverse/Options |
| REST UID + endpoint | Скользящее окно 1 s; `10006` означает превышение |
| UTA2.0 Pro чтение | `/v5/order/realtime`, `/v5/order/history`, `/v5/execution/list`: 50/s |
| UTA2.0 Pro торговля | create/cancel: контракты 10/s, Spot 20/s; amend: 10/s |
| Batch linear/inverse/spot | Отдельный от single endpoint бюджет; расход по числу ордеров, частичный успех возможен |

Ответы: `X-Bapi-Limit` — лимит endpoint, `X-Bapi-Limit-Status` — остаток, `X-Bapi-Limit-Reset-Timestamp` — время сброса при превышении, иначе текущий timestamp. Это не единый Binance-style weight. Конкретную квоту UID сверять по headers; таблицу Pro нельзя без проверки приравнивать к произвольному Demo/аккаунту. [Rate Limit Rules](https://bybit-exchange.github.io/docs/v5/rate-limit).

У WS trade отдельный IP предел 3000 req/s (`10403`); дополнительно account/op budget и соответствующие limit headers в ACK. [WS Trade Guideline](https://bybit-exchange.github.io/docs/v5/websocket/trade/guideline). Числовой предел subscribe/ping messages/s в проверенном Connect не опубликован; проект использует ограниченную очередь команд и backoff+jitter.

**Batch неоднозначность:** endpoint допускает 20 linear/inverse и 10 Spot orders/request, а общая rate-page указывает 1–10. Начальная политика проекта ≤10, до проверки конкретного рынка. [Batch Place Order](https://bybit-exchange.github.io/docs/v5/order/batch-place), [Rate Limit Rules](https://bybit-exchange.github.io/docs/v5/rate-limit).

## Instrument rules и неоднозначные единицы

`GET /v5/market/instruments-info`: для linear обязательно пройти cursor pagination, Spot ее не поддерживает. Хранить symbol/category/contractType/settleCoin. Контракты: `priceFilter.tickSize`, `lotSizeFilter.qtyStep`, `minOrderQty`, `minNotionalValue`, `maxOrderQty`, `maxMktOrderQty`, leverageFilter. Spot: `basePrecision`, `quotePrecision`, `minOrderAmt`, актуальные `maxLimitOrderQty`, `maxMarketOrderQty`; `minOrderQty` помечен deprecated, проверяется сумма. Не копировать числовые значения примеров; ограничения меняются. [Instruments Info](https://bybit-exchange.github.io/docs/v5/market/instrument).

Spot Market Buy по умолчанию задает сумму покупки; явно передавать `marketUnit=baseCoin/quoteCoin`. Market преобразуется в IOC Limit и может не исполниться из-за ликвидности/slippage. `orderLinkId` ≤36 символов, уникален; hedge требует `positionIdx=1/2`, one-way — 0. `reduceOnly=true` несовместим с TP/SL в том же create. [Place Order](https://bybit-exchange.github.io/docs/v5/order/create-order).

## Unknown outcome и reconciliation — проектное решение

`10000` означает Server Timeout, `10016` — server error; эти коды не доказывают отсутствие ордера. [Error Codes](https://bybit-exchange.github.io/docs/v5/error). До отправки атомарно сохранить intent и стабильный orderLinkId. При timeout не создавать новый ID и не повторять POST вслепую: статус Unknown, затем WS/order lookup, fills и позиции, ограниченные повторы чтения.

`GET /v5/order/realtime` поддерживает orderLinkId; после рестарта биржи закрытые ордера восстанавливать через history. [Open & Closed Orders](https://bybit-exchange.github.io/docs/v5/order/open-order). History может запаздывать из-за асинхронной обработки, поэтому отсутствие записи не означает безопасного повторного размещения. [Order History](https://bybit-exchange.github.io/docs/v5/order/order-list).

При гонке cancel/fill возможны два `Filled`; состояние не должно откатываться, комиссии/исполнение нельзя начислить повторно. [Private Order](https://bybit-exchange.github.io/docs/v5/websocket/private/order). Дедупликация fills по account/category/execId; сверять фактические qty, fee и feeCurrency из execution. [Private Execution](https://bybit-exchange.github.io/docs/v5/websocket/private/execution).

До интеграционной фазы остаются обязательными: проверка permissions/environment/регионального домена, точных лимитов UID, спорного hedge scope, Spot trailing capability и восстановления после сбоя. Официальные Demo и Testnet не следует обозначать как Internal Paper Trading.
