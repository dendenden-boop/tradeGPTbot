# Binance: проверка API для Phase 0

Проверено: **2026-09-05**, официальная документация Binance. Это исследование документации, не проверка доступности API из deployment-региона и не выполненные contract tests. Scope: обычный Spot account и USDⓈ-M linear perpetual account. COIN-M, Portfolio Margin и поставочные контракты не включены в первый адаптер; их нельзя объявлять поддержанными по наличию общей марки Futures.

## Совместимость

«Да» означает документированную возможность API; фактическое разрешение определяется рынком, инструментом, account mode и ключом.

| Возможность | Spot | USDⓈ-M perpetual |
| --- | --- | --- |
| Spot | Да | Не применимо |
| Futures / perpetual | Не применимо | Да; выбирать `contractType=PERPETUAL` через [Exchange Information](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data) |
| Demo / Testnet | **Две отдельные среды**, описаны ниже | Официальная среда testnet с demo-hostnames; не гарантирована полнота всех endpoints |
| REST | Да, `/api/v3` | Да, `/fapi`; версия зависит от endpoint |
| WS market data | Да, market streams | Да, отдельные `/public` и `/market` |
| WS private data | Да, подписка через WS API | Да, `/private`, `listenKey` |
| Market / limit | Да, `MARKET`, `LIMIT` | Да, `MARKET`, `LIMIT` |
| Stop / TP-SL | `STOP_LOSS[_LIMIT]`, `TAKE_PROFIT[_LIMIT]`, OCO; это ордера, не derivative position TP-SL | Conditional algo orders: `STOP[_MARKET]`, `TAKE_PROFIT[_MARKET]` |
| Trailing stop | Да, `trailingDelta` в BIPS | Да, `TRAILING_STOP_MARKET` через algo endpoint |
| Hedge mode | Не применимо к обычному Spot | Да; `LONG`/`SHORT`, отдельный account mode |

Типы ордеров: [Spot Trade](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/trade), [USD-M Trade](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade). Нативная поддержка не равна атомарному bracket на каждом рынке: это проверяется отдельной capability.

## Среды и адреса

| Scope | REST base | Public market WS | WS API / private |
| --- | --- | --- | --- |
| Spot LIVE | `https://api.binance.com` | `wss://stream.binance.com:443/ws/<stream>`; combined `/stream?streams=...` | `wss://ws-api.binance.com:443/ws-api/v3` |
| Spot TESTNET | `https://testnet.binance.vision` | `wss://stream.testnet.binance.vision/stream?streams=...` | `wss://ws-api.testnet.binance.vision/ws-api/v3` |
| Spot DEMO | `https://demo-api.binance.com` | `wss://demo-stream.binance.com/ws/<stream>` или `/stream?streams=...` | `wss://demo-ws-api.binance.com/ws-api/v3` |
| USD-M LIVE | `https://fapi.binance.com` | `wss://fstream.binance.com/public` и `wss://fstream.binance.com/market`, далее `/ws/<stream>` или `/stream?streams=...` | Trading: `wss://ws-fapi.binance.com/ws-fapi/v1`; user stream: `wss://fstream.binance.com/private/ws/<listenKey>` |
| USD-M TESTNET/DEMO | `https://demo-fapi.binance.com` | Документирован base `wss://demo-fstream.binance.com` | WS API документирован отдельно: `wss://testnet.binancefuture.com/ws-fapi/v1`; demo private routed paths требуют contract verification |

Источники адресов: [Spot REST](https://developers.binance.com/en/docs/products/spot/rest-api), [Spot streams](https://developers.binance.com/en/docs/products/spot/web-socket-streams), [Spot WS API](https://developers.binance.com/en/docs/products/spot/web-socket-api), [Spot Testnet](https://developers.binance.com/en/docs/products/spot/testnet/general-info), [Spot Demo Mode](https://developers.binance.com/en/docs/products/spot/demo-mode/general-info), [USD-M general](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info), [USD-M WS API](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-api-general-info), [USD-M private](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/user-data-streams).

Spot Testnet имеет независимые стаканы/цены, периодические сбросы примерно ежемесячно; доступны `/api`, но не `/sapi`. Demo Mode использует похожие на live цены/стаканы, имеет отдельные ключи и ручной reset; документация заявляет одинаковые с live features/filters/limits, однако это не доказательство идентичного исполнения. [Testnet](https://developers.binance.com/en/docs/products/spot/testnet/general-info), [Demo Mode](https://developers.binance.com/en/docs/products/spot/demo-mode/general-info).

USD-M теперь маршрутизирует depth/bookTicker в `/public`, aggTrade/markPrice/kline в `/market`. Notice указывает завершение legacy migration 2026-04-23, одновременно содержит неоднозначное обещание остаточной работы `/public` через старый URL. Решение: только routed paths; fallback на legacy запрещен конфигурацией. [Migration notice](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Important-WebSocket-Change-Notice).

## Подпись и private streams

Spot REST: `X-MBX-APIKEY`, подписанный payload query+body; HMAC-SHA256/hex либо RSA/Ed25519 по типу ключа. Нужны `timestamp`, `recvWindow` (default 5000 ms, max 60000 ms). WS signing имеет отдельную канонизацию сортированных параметров: REST signer не переиспользуется вслепую. [REST security](https://developers.binance.com/en/docs/products/spot/rest-api), [WS security](https://developers.binance.com/en/docs/products/spot/web-socket-api).

Spot private: `userDataStream.subscribe` требует authenticated Ed25519 session; альтернативный `userDataStream.subscribe.signature` подписывает запрос непосредственно. Нельзя проектировать новый Spot private feed как старый REST listenKey API. [User Data Stream subscription](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/ws-api/user-data-stream).

USD-M REST документирует HMAC-SHA256 от query+body, `X-MBX-APIKEY`, timestamp в ms и default recvWindow 5000 ms. WS сортирует подписываемые params, `DECIMAL` передается JSON-строкой. Другие key types требуют отдельного capability/contract test. [REST security](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info), [WS API](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-api-general-info).

USD-M `listenKey` действует 60 минут; PUT продлевает, истекший ключ пересоздается через `POST /fapi/v1/listenKey`. Это отдельный lifecycle от heartbeat и 24-часового соединения. [Private streams](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/user-data-streams).

## Лимиты и эксплуатация WS

| Соединение | Heartbeat / lifetime | Ограничения |
| --- | --- | --- |
| Spot streams | Server ping 20 s; ответ pong с тем же payload за 60 s; lifetime 24 h | 5 входящих **на сервер** сообщений/s, включая ping/pong/control JSON; 1024 streams/connection; 300 connection attempts/5 min/IP |
| Spot WS API | Ping 20 s, pong ≤60 s; 24 h | 300 attempts/5 min/IP; connect weight 2; request weights по методу |
| USD-M streams | Ping 3 min, pong ≤10 min; 24 h | 10 incoming messages/s; 1024 streams/connection; отдельный лимит connection attempts в прочитанной странице не указан |
| USD-M WS API | Ping 3 min, pong ≤10 min; 24 h | Handshake weight 5; ping/pong ≤5/s; request/order budgets |

Источники по строкам: [Spot streams](https://developers.binance.com/en/docs/products/spot/web-socket-streams), [Spot WS API](https://developers.binance.com/en/docs/products/spot/web-socket-api), [USD-M connect](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Connect), [USD-M WS API](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-api-general-info).

SUBSCRIBE/UNSUBSCRIBE отправляются batched JSON, подтверждения коррелируются `id`; lowercase stream symbol берется из instrument mapping. [Spot protocol](https://developers.binance.com/en/docs/products/spot/web-socket-streams), [USD-M protocol](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/Live-Subscribing-Unsubscribing-to-streams). Архитектурно: ротация до 24 h, jitter reconnect, общий бюджет egress-IP, отдельные public/private пулы. Число streams не равно числу symbols; 300 symbols × 3 feeds = 900 subscriptions — расчет, не результат load test.

REST бюджеты определяются `/api/v3/exchangeInfo` либо `/fapi/v1/exchangeInfo`, endpoint weights и response headers `X-MBX-USED-WEIGHT-*` (IP), `X-MBX-ORDER-COUNT-*` (account). При 429 — backoff; повторение ведет к 418. Spot возвращает `Retry-After`. Значения 6000/min Spot и 2400/min USD-M в примерах документации не фиксируются как гарантированные runtime quotas. [Spot limits](https://developers.binance.com/en/docs/products/spot/rest-api), [USD-M limits](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info).

USD-M WS API имеет отдельный IP weight budget от REST, **но** REST single/batch place/modify/cancel расходуют общий с WS бюджет; `ORDERS` общий по UID. Это требует нескольких пересекающихся bucket, а не независимых REST/WS throttlers. [WS rate limits](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-api-general-info).

## Precision, ордера, восстановление

- Spot: `PRICE_FILTER.tickSize`, `LOT_SIZE.stepSize`, `MARKET_LOT_SIZE`, `MIN_NOTIONAL`/`NOTIONAL`, price-band filters читаются динамически. Округление по числу decimal places недостаточно. [Filters](https://developers.binance.com/en/docs/products/spot/filters).
- Spot MARKET `quantity` — base asset; `quoteOrderQty` — сумма quote для покупки/получения при продаже. Нельзя объединять их в безразмерное amount. [New order](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/trade). Trailing `100` BIPS = 1%; проверить `TRAILING_DELTA`. [Trailing FAQ](https://developers.binance.com/en/docs/products/spot/faqs/trailing-stop-faq).
- USD-M `pricePrecision`/`quantityPrecision` прямо запрещено использовать вместо tickSize/stepSize. Проверять contract type, margin asset, filters, `triggerProtect`; qty не трактовать как quote spend. [Exchange Information](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data).
- Conditional USD-M: `POST /fapi/v1/algoOrder`, `clientAlgoId`/`algoId`, `triggerPrice`, trailing `activatePrice`/`callbackRate` (0.1–10). `reduceOnly` нельзя передавать в Hedge Mode; нужен `positionSide`. Переключение hedge — account-wide, после CM migration затрагивает UM и CM; не менять автоматически. Каталог обычного order все еще перечисляет conditional enum: это документарная неоднозначность, не основание обходить algo endpoint. [USD-M Trade](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade).

Spot `-1007` после 10 s и 5xx не доказывают отказ: сверять private feed и query order. [Timeout](https://developers.binance.com/en/docs/products/spot/rest-api). USD-M 503 с unknown error допускает успешное исполнение; документированные Service Unavailable и -1008 имеют другую семантику. [503 variants](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info).

Архитектурное решение: durable OrderIntent/client ID до отправки; UNKNOWN → RECONCILIATION_REQUIRED; запросы обычных и algo orders разделены. Ни transport `id`, ни уникальность client ID среди **открытых** ордеров не обеспечивают вечную идемпотентность. После timeout запрещена слепая повторная отправка. [Client order semantics](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/trade).

До Phase 5 остаются: реальные metadata/rate snapshots каждой среды; региональная достижимость; private auth и reset recovery; demo routed WS; stale/gap recovery; lost-response обычного/algo order. Известное несоответствие Spot Testnet таблицы raw `/stream` подтверждать отдельным тестом; для начального профиля выбран явно описанный combined endpoint. Никаких ключей или ордеров в Phase 0 не использовалось.
