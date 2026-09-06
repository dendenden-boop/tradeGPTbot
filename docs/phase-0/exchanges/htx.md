# HTX — исследование API

Проверено **2026-09-05**. Официальные legacy reference прочитаны; новый [HTX API portal](https://www.htx.com/en-us/opend/newApiPages/) не вернул извлекаемого текста через web-инструмент. Это ограничение подтверждения актуальности, особенно для новых account modes; не доказательство их отсутствия. Доступность API и счета не тестировалась.

## Spot: документированная база

REST `https://api.huobi.pro`; public WS `wss://api.huobi.pro/ws`, incremental MBP `wss://api.huobi.pro/feed`; private `wss://api.huobi.pro/ws/v2`. Spot Testnet помечен остановленным. Есть market/limit, stop-limit и conditional/trailing. Market buy amount — quote, sell — base; symbol lowercase, правила инструмента динамические.

REST подпись: HMAC-SHA256/Base64, method, lowercase host, path, отсортированные/URL-encoded параметры, UTC Timestamp, SignatureVersion=2; private WS auth использует версию 2.1. Public WS gzip, ping каждые 5s; private ping 20s, pong возвращает timestamp. Private предел — 10 connections/API key. Place `/v1/order/orders/place`: 100/2s; open orders: 50/2s; scope UID+endpoint. Headers: `X-HB-RateLimit-Requests-Remain`, `X-HB-RateLimit-Requests-Expire`. Универсальный лимит symbols/connection не установлен прочитанным разделом.

Биржа не проверяет уникальность Spot client-order-id; lookup завершённых ордеров ограничен 2h от создания, остальных — 8h. [Официальный Spot reference: access, authentication, trading, conditional, WS, changelog](https://huobiapi.github.io/docs/spot/v1/en/)

## USDT contracts: документированная база

REST `https://api.hbdm.com`; public WS `wss://api.hbdm.com/linear-swap-ws`; private `wss://api.hbdm.com/linear-swap-notification`. Поддержаны perpetual/futures, market/limit, trigger, TP/SL, trailing, hedge/one-way. Volume — контракты; contract size и settlement сохраняются отдельно. `reduce_only` неприменим в hedge; offset/position semantics зависят от режима.

REST/WS auth — HMAC-SHA256/Base64 с canonical method/host/path/query. Лимиты UID: 72 trade + 72 read/3s; public non-market 240/3s/IP; market REST 800/s/IP, общий между производными продуктами. Private WS максимум 30/UID. Раздел WS задаёт req 50/s; REST-обзор описывает «50 at once»: неоднозначность. Отдельно WS указывает максимум 40 subscriptions/s, несмотря на общую фразу об отсутствии sub-лимита; итоговый topic cap не подтверждён. Headers `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`, `ratelimit-interval` используются динамически. [USDT contracts reference](https://huobiapi.github.io/docs/usdt_swap/v1/en/)

## Более новое изменение и последствия

Объявление **2025-05-08** вводит V5 для Multi-Assets Collateral. Для такого режима client_order_id становится недействительным сразу после fill/cancel; для прочих состояний максимум 8h. Single-Asset сохраняет ограничение 8h. V1/V3/V5 выбираются по конкретной операции и account profile, не глобальной строкой версии. [HTX: V5 Multi-Assets Collateral](https://www.htx.com/support/25000935499340)

## Решение проекта и незакрытые вопросы

HTX `EXCHANGE_DEMO` остаётся **unverified/disabled** для деривативов; для Spot legacy testnet остановлен. SDK/Postman «demo» не признаётся биржевой sandbox. Использовать Internal PAPER с public data; не подставлять live URL в demo profile.

Перед PHASE 8: проверить новый portal, точный account mode, действующие endpoint versions, heartbeat/лимиты выбранного derivatives WS, instrument metadata, private permissions и возможности algo. Прочитанные legacy квоты — сведения для исследования, не разрешение выставить такую нагрузку. Начальная политика ниже документированных пределов, с общим IP/UID budget и постепенным подтверждением.

Проектный recovery: сохранить уникальное внутреннее намерение, exchange client ID и dispatch evidence до отправки. Timeout → UNKNOWN; искать обычные/conditional orders и fills раздельно. Отсутствие по истёкшему client ID не разрешает повтор. Неопределённость сохраняет risk reservation и блокирует новые позиции; operator review не подменяет доказательство отсутствия исполнения.
