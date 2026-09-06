# OKX API v5 — проверка PHASE 0

Дата проверки: **2026-09-05**. Только официальные источники OKX; ключи, сеть API и исполнение сделок не проверялись. «Поддерживается» ниже означает документированную возможность, а не доступность конкретному аккаунту или подтверждённую работу Demo.

## Адреса и разделение окружений

Каждая WS-ячейка задаёт **три точных адреса**: заменить `{public|private|business}` одним из перечисленных сегментов.

| Регистрация / среда | REST base URL | WS URL | Источник |
|---|---|---|---|
| Global / Production | `https://openapi.okx.com` | `wss://ws.okx.com:8443/ws/v5/{public\|private\|business}` | [Global: Production](https://www.okx.com/docs-v5/en/#overview-production-trading-services) |
| Global / Demo | `https://openapi.okx.com` | `wss://wspap.okx.com:8443/ws/v5/{public\|private\|business}` | [Global: Demo](https://www.okx.com/docs-v5/en/#overview-demo-trading-services) |
| US/AU, регистрация `app.okx.com` / Production | `https://us.okx.com` | `wss://wsus.okx.com:8443/ws/v5/{public\|private\|business}` | [US/AU](https://app.okx.com/docs-v5/en/#overview-production-trading-services) |
| US/AU / Demo | `https://us.okx.com` | `wss://wsuspap.okx.com:8443/ws/v5/{public\|private\|business}` | [US/AU Demo](https://app.okx.com/docs-v5/en/#overview-demo-trading-services) |
| EEA, регистрация `my.okx.com` / Production | `https://eea.okx.com` | `wss://wseea.okx.com:8443/ws/v5/{public\|private\|business}` | [EEA](https://my.okx.com/docs-v5/en/#overview-production-trading-services) |
| EEA / Demo | `https://eea.okx.com` | `wss://wseeapap.okx.com:8443/ws/v5/{public\|private\|business}` | [EEA Demo](https://my.okx.com/docs-v5/en/#overview-demo-trading-services) |

Demo REST требует `x-simulated-trading: 1` и отдельный Demo API key. Некоторые операции, включая withdrawal/deposit, там отсутствуют. Global-домен нельзя считать заменой региональному. [Global overview](https://www.okx.com/docs-v5/en/#overview)

Турецкая документация отдельно задаёт Production REST `https://tr.okx.com`; её WS использует `ws.okx.com:8443`. Подтверждённой таблицы турецких Demo-адресов на прочитанной странице нет. [TR Production](https://tr.okx.com/docs-v5/en/#overview-production-trading-services)

Несовпадение региона и домена может давать `50119`. [OKX API FAQ](https://www.okx.com/en-us/help/api-faq)

**Проектное решение:** хранить атомарный профиль `{region, environment, rest, wsPublic, wsPrivate, wsBusiness, credentialRef}`; запрещать смешивание Demo/Production в одном профиле. Не определять регион по языку интерфейса или часовому поясу. Допуск инструмента проверять для аккаунта отдельно.

## Подпись и WebSocket

REST private: `OK-ACCESS-KEY`, `OK-ACCESS-PASSPHRASE`, `OK-ACCESS-TIMESTAMP`, `OK-ACCESS-SIGN`; JSON body. Подпись: `Base64(HMAC-SHA256(secret, timestamp + UPPERCASE(method) + requestPathIncludingQuery + exactBody))`. Timestamp — ISO8601 UTC с миллисекундами; расхождение свыше 30 секунд отвергается. WS login подписывает `epochSeconds + 'GET' + '/users/self/verify'`; срок — 30 секунд. [Authentication / Login](https://app.okx.com/docs-v5/en/#overview-rest-authentication)

| WS ограничение | Значение / область |
|---|---|
| Соединения | 3 попытки/сек/IP |
| login + subscribe + unsubscribe | 480 запросов/час/соединение суммарно |
| Размер подписок в запросе | ≤64 KB |
| Heartbeat | При отсутствии сообщений N<30 секунд отправить строку `ping`; ожидать `pong`, иначе reconnect |
| Одновременные private subscriptions | 30 соединений/канал/субаккаунт: orders, account, positions, balance_and_position, position-risk, account-greeks |

Без подписки/поступления данных более 30 секунд соединение разрывается. [WS Connect / Subscribe](https://app.okx.com/docs-v5/en/#overview-websocket)

`business` содержит публичные свечи и приватные `orders-algo`/`algo-advance`; название адреса не определяет необходимость login. Переезд этих каналов распространяется на live и Demo. Исторические примеры с `brokerId=9999` не использовать вместо актуальной таблицы адресов. [Официальное уведомление о маршрутизации](https://www.okx.com/en-sg/help/changes-to-v5-api-websocket-subscription-parameter-and-url)

**Проектное решение:** login/subscribe ACK, heartbeat, подтверждение подписки и свежесть рыночных данных — разные состояния. Использовать backoff+jitter, общий лимитер reconnect по IP, повторную подписку и сверку состояния после разрыва.

## Возможности и лимиты

| Возможность | SPOT | SWAP (perpetual) / FUTURES (expiry) |
|---|---|---|
| Public REST / public WS | Да | Да |
| Private REST / private WS orders | Да | Да |
| Обычные market / limit | Да | Да |
| Demo API | Документировано | Документировано; доступность инструмента проверить |

Обычные ордера: REST `POST /api/v5/trade/order`, WS private `op=order`. [Global Trade](https://www.okx.com/docs-v5/en/#order-book-trading-trade-post-place-order)

Public REST лимитируется по IP, private REST/WS trading — по UID, часто UID+instId. Place: 60 запросов/2 секунды; REST и WS делят лимит. Place/amend/cancel имеют отдельные корзины. Субаккаунт: базово 1000 new+amend ордеров/2 секунды; batch считается по ордерам; действуют дополнительные fill-ratio tiers. `50011`/`50061` означают ограничение. [Global Rate Limits](https://www.okx.com/docs-v5/en/#overview-rate-limits)

| Native algo через REST `POST /api/v5/trade/order-algo` | Область / параметры |
|---|---|
| Stop / TP-SL | SPOT, SWAP, FUTURES: `conditional`, `oco`, `trigger`; исполнение market через цену `-1` либо limit |
| Trailing | `move_order_stop`; один из `callbackRatio`/`callbackSpread`, необязательный `activePx` |
| Algo limit | 20 запросов/2 секунды/UID+instId; Copy Trading имеет особые лимиты |

Эти возможности и производные параметры присутствуют в региональной EEA схеме; это не подтверждение допуска любого EEA пользователя к деривативам. [EEA Algo Trading](https://my.okx.com/docs-v5/en/#order-book-trading-algo-trading-post-place-algo-order)

В прочитанной US/AU схеме algo-запроса перечислен `tdMode=cash`; нельзя автоматически переносить туда деривативную схему. [US/AU Algo](https://app.okx.com/docs-v5/en/#order-book-trading-algo-trading-post-place-algo-order)

Standalone WS placement algo-ордеров не подтверждён. **Проектное решение:** native algo через REST; состояние через business WS + REST reconciliation. Полную матрицу Demo × регион × account mode × instrument × algo подтвердить интеграционными проверками позднее.

Futures/Multi-currency поддерживают net и long/short, Portfolio — net. [Position mode](https://my.okx.com/docs-v5/en/#trading-account-rest-api-set-position-mode) Для переключения требуется отсутствие позиций и pending orders. [Условия переключения](https://www.okx.com/docs-v5/trick_en/#configuring-accounts-and-sub-accounts)

## Размеры и денежные единицы

`tickSz` — шаг цены; `lotSz` — шаг количества; `minSz` — минимум. Для контрактов количество задаётся контрактами, для SPOT/MARGIN эти metadata-поля — base currency. Линейный notional: `sz × ctVal × markPx`; inverse: `sz × ctVal` USD. Проверять `ctType`, `ctValCcy`, `settleCcy`, максимумы и `state`. [EEA Instruments](https://my.okx.com/docs-v5/en/#public-data-rest-api-get-instruments)

Старый официальный tutorial описывает номинал одного контракта через `ctVal × ctMult`; актуальная schema формулирует расчёт через `ctVal`. Это требует проверки фактических metadata выбранного контракта, особенно нестандартного multiplier. [Derivatives tutorial](https://www.okx.com/en-ae/help/how-can-i-do-derivatives-trading-with-the-jupyter-notebook)

SPOT market: `tgtCcy=quote_ccy` — бюджет котируемой валюты, `base_ccy` — количество базовой; defaults: buy quote, sell base. Например, `BTC-USDT`, buy, `sz=75`, `tgtCcy=quote_ccy` задаёт бюджет 75 USDT. `tdMode=cash` применяется к spot в Spot/Futures account mode; для других account modes схема отличается. [Spot tutorial](https://www.okx.com/en-us/help/how-can-i-do-spot-trading-with-the-jupyter-notebook)

**Проектное решение:** decimal-строки и явный `quantityUnit`, без JS `number` для денег; отдельная конверсия base/quote/contracts. После округления повторно проверять шаг, минимум, максимум и риск. Не считать остаток баланса полностью доступным для market buy; preflight должен учитывать резерв и фактические комиссии. Market ACK не даёт гарантию цены или полного исполнения.

## Неопределённый исход и восстановление

`50004` при размещении означает неизвестный результат: запрос мог исполниться или завершиться неуспешно. [API FAQ: timeout](https://www.okx.com/en-us/help/api-faq)

`clOrdId` — до 32 букв/цифр; уникальность биржа проверяет среди pending orders. ACK размещения/изменения/отмены не доказывает финальное состояние. `orders` WS не отправляет initial snapshot; доступны `GET /api/v5/trade/orders-pending`, запрос состояния и history/fills. Batch допускает частичный успех: проверять каждый `sCode`. [Best practices: Order management](https://www.okx.com/docs-v5/trick_en/#order-management)

`expTime` ограничивает срок принятия place/amend (включая batch): REST header, WS поле, Unix milliseconds. Это не автоматическая отмена уже принятого ордера. [Transaction Timeouts](https://tr.okx.com/docs-v5/en/#overview-transaction-timeouts)

**Проектный алгоритм:** до отправки сохранить intent и никогда не переиспользуемый client ID; при timeout/disconnect — `UNKNOWN`, запретить слепую повторную отправку. Подписаться, буферизовать события, сверить REST open orders/details/history/fills, применить события с дедупликацией и проверить balances/positions. Единичный «не найден» не считать доказательством неисполнения. Неустранённую неоднозначность оставить в журнале и заблокировать увеличение риска. Для algo сохранять `algoClOrdId`/`algoId` отдельно от regular `ordId`.

## Открытые проверки перед реализацией

- **Регион, доступные продукты, account/position mode, Demo credentials:** неизвестны для пользователя.
- **Доступность Demo algo и fills, реальные лимиты аккаунта, комиссии:** документами целиком не гарантированы, авторизованные API проверки не выполнялись.
- **WS schema drift:** TR документация уже показывает обязательный `instIdCode` в WS order operations; не копировать глобальные примеры с `instId` без проверки регионального changelog. [TR WS Cancel](https://tr.okx.com/docs-v5/en/#order-book-trading-trade-ws-cancel-order)
- **Полная global HTML-страница:** web open ограничился ошибкой размера >4 MB; global claims проверены официальными индексированными фрагментами. Региональные страницы и help/best-practice страницы прочитаны непосредственно. Перед PHASE 1 нужен повторный просмотр точной региональной schema.

**Предложение для первой интеграции:** REST mutations + private/business WS updates, SPOT cash и линейный SWAP net, отдельные capability flags; hedge, inverse и расширенные algo включать только после проверки соответствующей комбинации условий. Это архитектурное предложение, не уже реализованная функциональность.
