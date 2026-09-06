# План PHASE 0–22 и критерии PHASE 1

Основание: разделы 1, 77–80, 94–97 пользовательского задания, [архитектура](../architecture.md), [требования и противоречия](requirements.md). Дата: 2026-09-05. **Сейчас выполняется только PHASE 0.** Все команды, модули, тесты и числовые критерии ниже — план будущей реализации; успешные runtime-проверки этим документом не заявляются.

## Правила перехода между этапами

Порядок пользователя сохраняется. До реализации каждого существенного модуля фиксируются requirements, edge cases, failure scenarios, interfaces и tests. Этап закрывается после исправления обнаруженных проблем и успешного повторения затронутых проверок. Failed test, ошибка compilation/lint, unhandled rejection, обход input validation/ownership, утечка credentials либо критический дефект идемпотентности блокируют переход.

Общий gate начиная с PHASE 1: formatter, lint, typecheck, unit tests, относящиеся к этапу integration tests, clean build; при наличии нового runtime — запуск, основные endpoints, shutdown и анализ логов. Проверяются error paths, необоснованный `any`, race conditions, повторное выполнение и security implications. Тестовые doubles допустимы внутри тестов; production-заглушка обязана иметь `TODO: PRODUCTION IMPLEMENTATION REQUIRED` и не может считаться готовой функцией. Нельзя ослаблять проверки или удалять тест для получения зелёного результата.

Отчёт этапа: реализовано; решения; точный список файлов; реально выполненные команды с результатами; security/performance; известные ограничения; следующий этап. Отсутствующая зависимость или среда означает BLOCKED/NOT RUN для проверки, а не PASS. В PHASE 0 runtime/lint TS/unit/integration — N/A: выполняется проверка документов и ссылок, bootstrap не начинается.

**LIVE gate:** в PHASE 5–8 реализуется протокол адаптера, включая live-профиль, сериализацию и обработку ответов. Публичные данные и разрешённые read-only проверки не являются исполнением. Dispatch любого реального ордера запрещён до завершения Order Engine PHASE 11, Risk Engine PHASE 12 и их security/recovery tests. До этого mutation tests используют fixtures/локальный протокольный сервер; прямой вызов биржи «для проверки» не обходит gate. После PHASE 12 нужен отдельный явный допуск конкретного пользователя/аккаунта; коммерческий production release дополнительно ждёт PHASE 19–22. Режим по умолчанию — PAPER.

## Последовательность реализации

| Этап пользователя | Объём | Обязательный gate результата |
| --- | --- | --- |
| **0 — Research and Architecture** | Официальные API четырёх бирж, compatibility, архитектура/data flow, threat model, performance assumptions, ADR, план | Все требования имеют место в плане; источники/дата/ограничения указаны; неизвестные capabilities не выданы за поддерживаемые; runtime не заявлен; остановка на границе документации |
| **1 — Project Bootstrap** | Monorepo, Node/TS/pnpm, lint/format/tests, Docker/PostgreSQL/Redis, config, logging, API lifecycle | Все измеримые критерии следующего раздела; clean install/build и реальный Docker startup |
| **2 — Database** | Schema, migrations, constraints/indexes, development seed, ownership | Fresh DB и upgrade с предыдущей схемы сохраняют данные; reset только disposable test DB; повтор seed идемпотентен; уникальность intent/fill/inbox проверяется конкурентными транзакциями; EXPLAIN для заявленных hot queries |
| **3 — Authentication** | Signup, email verification, login/logout, reset, sessions, архитектура 2FA | Argon2id; HTTP-only cookies; expiry/revoke/rotation; reset token одноразовый; CSRF/rate-limit/replay; User A не читает/изменяет User B; письма через локальный test sink, доставка production не подменена mock |
| **4 — Exchange Core** | Domain types, decimal/units, capability scope, errors, instrument registry ports, test adapter | Contract suite для каждого метода; malformed data/unsupported/unverified fail closed; scoped environment исключает подмену; test adapter не регистрируется в production composition root |
| **5 — Binance** | Public REST → instruments → WS → private auth/balances/orders/positions → testnet/live profiles | Signed fixtures, precision/filters, rate scopes, REST/WS recovery; Spot и выбранные USDT perpetual раздельно; авторизованные contract probes при доступности; никаких live mutations до LIVE gate |
| **6 — Bybit** | Та же последовательность; Demo и Testnet отдельно | Account/category/positionIdx, base/quote market qty, Demo routing, duplicate Filled, ACK/unknown; спорный hedge scope выключен до проверки; LIVE gate сохраняется |
| **7 — OKX** | Та же последовательность; passphrase и account/trade modes | Подпись, demo header/домены, contract sizes, algo ID/ordinary order ID, private auth/reconnect; неподтверждённые region/product capabilities выключены; LIVE gate сохраняется |
| **8 — HTX** | Та же последовательность; Spot и contract API раздельно | Signature, gzip/ping variants, market-buy units, private auth/orders, precision; неподтверждённый demo не маскируется под официальный; будущий Paper отдельно; LIVE gate сохраняется |
| **9 — Market Data Engine** | WS pools, sharding, subscriptions, reconnect/stale, aggregation, 30s candles, persistence | 300 уникальных exchange-market-symbol keys в заданном профиле; bounded memory/queues; gap и resnapshot; duplicates/out-of-order/late trades; 30s из реальных trades, missing quality сохранена; отказ одной пары не останавливает остальные |
| **10 — Portfolio** | Balances, fills/ledger, positions, unified valuation, reconciliation | Decimal accounting; snapshot+delta не удваивают fills; stale price/balance отражаются; restart recovery; pending/unknown/reserved funds учтены; PnL/fees/funding и currency units сверены с эталонами |
| **11 — Order Engine** | Durable OrderIntent, state machine, submit/cancel/amend, inbox/outbox, fills, reconciliation | Lost response, crash до/после send, повтор queue job, late worker, partial fill во время cancel; неизвестный исход не повторяет POST; unique attempt/CAS проверены; live dispatch остаётся заблокированным до PHASE 12 |
| **12 — Risk Engine** | Все risk rules, atomic reservations, final dispatch gate, scope kill switches, circuit breakers | Два конкурентных intents не превышают общий лимит; stale/unknown/DB/limiter failure блокируют новый риск; manual/strategy/TWAP/rebalance не обходят Risk; cancel/reduction проверены отдельно; close не открывает обратную позицию |
| **13 — Paper Engine** | Отдельный виртуальный account/ledger, simulation, fees/slippage/latency, partial fills | Детерминированный seed; balance conservation; volume/ликвидность ограничивают fills; unavailable market data не дают вымышленных цен; то же Intent/Risk API; live credentials недоступны |
| **14 — Strategy Engine** | Strategy API, indicators/signals, persistent state/cursors, scheduling/isolation | Warm-up, closed-candle policy, repeated input, restore/restart, конкурентные workers; signal+state atomic; CPU/time/memory bounds; ошибка одной strategy/instrument изолирована; пользовательский код не исполняется |
| **15 — Built-in Strategies** | По одной: DCA, Grid, EMA, RSI, Bollinger, MACD, Breakout, Trend Following, Trailing, Rebalance, TWAP | Для каждой: parameter validation, unit и детерминированный replay/backtest test, risk limits; TWAP child intents и averaging не обходят риск; описаны режимы/риски/ограничения; переход к следующей стратегии только после gate |
| **16 — Backtesting** | Historical ingestion/quality, общий Strategy API, simulation, fees/funding, metrics/reports | No look-ahead; dataset/rules/model versions+seed; gaps и невозможность восстановить 30s из 1m; консервативные intrabar TP/SL; zero denominator → unavailable; повтор одного run воспроизводим; повторно интегрированы все стратегии PHASE 15 |
| **17 — Web UI** | Auth/dashboard/connections → portfolio/orders/trading → strategies/builder/backtests/settings | Server source of truth; RU/EN resources; onboarding/help и Paper/Demo/Live; secret после сохранения не возвращается; формы/ownership/capabilities; bounded JSON DSL без eval; доступность, responsive и нужная virtualization |
| **18 — Realtime UI** | Authenticated WS, snapshots/revisions, dedup/state sync, reconnect | Cross-user subscribe отклоняется; expiry/revoke/Origin; disconnect/reload восстанавливает серверное состояние; gap → resync; медленный клиент не теряет финансовые изменения молча |
| **19 — Security Review** | Независимый обзор threat model, code, dependency/config, checklist и исправления | Tenant isolation, secrets/envelope rotation, SSRF, CSRF/XSS/injection, permission audit, no withdrawals; critical/high risks закрыты либо release блокирован; regression tests для исправлений |
| **20 — Performance** | 300 baseline, 600 stretch, отдельный профиль 1200 при необходимости; load/soak/leak | Зафиксированы hardware/users/accounts/event rates; 300 проходит SLO из market-data design; 600 измерен как stretch; длительный soak, reconnect storm и dependency outage; memory/queue рост ограничен; приведены фактические графики/метрики |
| **21 — E2E** | Полный пользовательский flow, включая ошибки/восстановление | Signup → connection → strategy/backtest → paper/demo → orders/fills/portfolio; manual/cancel/TP-SL; multi-user isolation; reconnect/restart; LIVE только при явном отдельном допуске, отсутствие допуска честно ограничивает evidence |
| **22 — Production Readiness** | Secrets, migrations, backups, monitoring/logs/alerts, health/rate limits, DR/rollback | Реальный restore drill в изоляции; доказанные RPO/RTO; migration/deploy/rollback rehearsal; alerts доходят; runbooks и response ownership; `docs/production-readiness.md`; production разрешается отдельно после review |

Начальный adapter coverage — Spot и USDT linear perpetual. Dated/inverse futures не исчезают из требования: каждая биржа получает отдельный capability gate, contract/units/accounting/risk/backtest tests до включения этих рынков. Beta не объявляется готовой при незакрытых обязательных возможностях из раздела 94 задания.

PHASE 15 требует backtest test раньше полного PHASE 16. Для этого в PHASE 15 используется небольшой детерминированный replay harness как тестовая инфраструктура Strategy API. Он не объявляется готовым пользовательским Backtesting Engine; PHASE 16 повторно проверяет стратегии уже через полный движок.

## PHASE 1: объём и границы

Результат — воспроизводимый, наблюдаемый backend bootstrap с реальными dependency probes. Функции авторизации, торговые маршруты, exchange clients, финансовая schema и симуляторы не реализуются раньше своих этапов. Monorepo должен содержать работающие `apps/api`, `packages/config`, `packages/logger` и общие workspace/tooling настройки. Остальные приложения/пакеты создаются по мере реализации; пустые workers с фиктивным success не нужны. Web product UI остаётся PHASE 17.

Runtime — Node.js **24 LTS** из архитектуры. Перед установкой проверить актуальный security patch, совместимые версии TypeScript/Fastify и остальных инструментов, maintenance/license/advisories. Точный Node patch, pnpm и версии direct dependencies фиксируются в repository metadata, lockfile и CI; слово `latest` не обеспечивает воспроизводимость. Turborepo не обязателен. PostgreSQL/Redis versions и image digests также фиксируются после проверки поддержки.

### Проработка модулей до реализации

| Модуль | Requirements и интерфейс | Edge cases / failure scenarios | Содержательные проверки |
| --- | --- | --- | --- |
| Workspace/toolchain | Один pnpm workspace/lockfile; направленные зависимости; общие tsconfig/lint/format; scripts lint/typecheck/test/build | Чистая машина без global CLI; несовместимый Node; missing lockfile; циклический import; stale generated output | Установка frozen lockfile в чистом disposable checkout; build из отсутствующего dist; clean CI; несовместимый runtime даёт понятный отказ; package imports работают после build |
| Config | `loadConfig(rawEnv) → AppConfig` либо типизированная sanitized ConfigError; runtime schema; immutable config; явные defaults | Пустой/нечисловой port, неверные enum/URL/protocol, missing DB/Redis DSN; отсутствующий production secret; whitespace; false как строка | Таблица валидных/ошибочных входов; invalid config завершает процесс до listen; сообщения показывают имя поля без значения; HTTP bind/log level/timeout действительно применены |
| Logger | `createLogger(config)` и request child context; структурированный JSON; stable error code/requestId | Error с вложенным cause/body, credentials в DSN/query, Authorization/Cookie, secret-like fields; log sink закрыт; слишком большой client requestId | Sentinel-secret нигде в stdout/stderr; exception сериализуется безопасно; requestId связан с ответом и логом; client ID валидируется или заменяется; production без stack/raw payload |
| API composition | `buildApp({config, logger, health}) → FastifyInstance`; запуск отдельно; schemas и общий error envelope | Malformed JSON, oversized body, неизвестный route, handler exception, client disconnect | HTTP-level integration: правильные status/content-type/error codes, requestId, отсутствие внутренних деталей; unsupported routes возвращают 404, payload limit — 413; client disconnect не вызывает unhandled rejection |
| Dependency health | `probe(): Promise<DependencyHealth>` с timeout/checkedAt/status; реальные PostgreSQL `SELECT 1`, Redis `PING`; bounded pool | DB/Redis недоступны при старте; outage после readiness; медленный ответ; восстановление; pool exhaustion | Настоящие disposable services: ready 503 при отказе каждой зависимости, 200 после восстановления; live остаётся 200; deadline конечен; повтор probes не создаёт неограниченных clients |
| Lifecycle | `start()`/`stop(reason)`; readiness false до готовности и при draining; SIGTERM/SIGINT; закрытие HTTP/pools/log output | Два shutdown сигнала, старт частично завершён, inflight request, dependency close завис, port занят | Linux-container process tests: перестаёт принимать новую работу, заканчивает допустимый inflight, закрывает handles; повтор stop безопасен; deadline приводит к диагностируемому exit; ошибка bind имеет nonzero exit |
| Docker/CI | Multi-stage non-root runtime, Compose API/Postgres/Redis, pinned images; ephemeral CI DB; secrets только через env/secret provider | Сервисы стартуют медленнее API; образ не содержит dev env; недоступен registry; lockfile изменён; тесты оставили данные | Compose readiness; image inspection; container runtime UID; CI frozen install/build/checks; ошибка зависимости не скрыта; повтор прогонов не зависит от старой DB |

Это контракты проектирования, а не добавленный TypeScript-код. В тестах подменяется только контролируемая граница конкретного отказа; реальный HTTP/процесс/DB/Redis проверяется там, где именно их поведение составляет критерий.

### Измеримые acceptance criteria PHASE 1

Все пункты обязательны для закрытия. Временные значения ниже — начальные проектные цели для локальной/CI среды; изменение допускается с аргументированным ADR до прогона, а не после провала.

1. **Reproducibility:** clean checkout + зафиксированный Node/pnpm → frozen install без изменения lockfile → build всех реализованных packages/API. Build не зависит от ранее созданного `dist` или глобально установленного инструмента. Проверка выполняется на Linux CI и пользовательской Windows среде, либо различие явно блокирует заявленную поддержку.
2. **Type safety:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noImplicitOverride`, `noFallthroughCasesInSwitch`; typecheck без emit. ESLint запрещает необоснованный explicit `any` и unsafe операции; внешние данные проходят `unknown` + schema. Исключения требуют локального объяснения, изоляции и review; blanket-disable недопустим.
3. **Checks:** formatter check, lint с нулём warnings, typecheck, unit, integration и build имеют exit code 0. Suites действительно выполняют тесты; нулевое количество обнаруженных тестов считается ошибкой. В покрытии имеются все перечисленные failure paths; произвольный процент coverage не заменяет проверку поведения.
4. **Config:** отсутствующий/невалидный обязательный параметр приводит к nonzero exit до начала listen. `.env.example` содержит только безопасные placeholders и описание; `.env*` с фактическими значениями не tracked. В production нет default password или автоматического fallback на development DSN. Денежных вычислений в bootstrap нет.
5. **Logging/security:** один структурированный completion log на законченный HTTP request, requestId присутствует в ответе; ошибочные запросы не раскрывают stack, DSN, Authorization, Cookie и sentinel credentials. Limit request body и timeout настроены. Сырой request/response body по умолчанию не логируется. Финансовые/withdrawal endpoints отсутствуют.
6. **Health:** `GET /health/live` возвращает 200, если процесс обслуживает запросы; не вызывает DB/Redis. `GET /health/ready` возвращает 200 только после успешных bounded probes обеих зависимостей и завершения startup, иначе 503. Каждый probe ограничен 1 s; общий handler budget 1.5 s при параллельных probes. Если используется cache, возраст положительного результата не превышает 5 s; при startup/draining readiness немедленно false. Ответ не раскрывает hosts/credentials/stack.
7. **Failure/recovery:** реальное отключение отдельно PostgreSQL и Redis приводит к ready 503 не позднее 6.5 s с учётом разрешённого cache и probe deadline. После восстановления оба probes возвращают ready 200 не позднее того же окна. API не накапливает бесконечные reconnect attempts, callbacks или pending health requests; ограниченные pool/queue settings явно заданы.
8. **Shutdown:** SIGTERM переводит readiness в false и прекращает приём новых HTTP requests; текущие запросы и connection pools закрываются в общем окне 10 s. Штатное завершение — exit 0; превышение окна/фатальная startup ошибка — nonzero и sanitized причина. Повторный сигнал/повтор stop не создаёт исключение. В runtime/logs нет unhandled rejection и необработанного runtime exception.
9. **Compose:** API, PostgreSQL, Redis стартуют одной документированной командой; внутри выбранного reference CI profile ready достигается за 60 s после старта уже загруженных образов. DB/Redis не публикуются на внешние интерфейсы; при необходимости local ports привязаны к loopback. App container выполняется non-root; реальные secrets не входят в image/layers/build args. В PHASE 1 нет финансовых migrations: только connectivity, schema начинается PHASE 2.
10. **Isolation:** integration использует отдельный project name/database namespace и credentials; ничего не делает с существующей пользовательской БД/volumes. Cleanup ограничен проверенными disposable ресурсами этого test run. Повторный запуск получает чистый namespace и тот же результат.
11. **CI:** на push/PR выполняется clean frozen install, format/lint/typecheck/unit/integration/build и Docker smoke; failure любого обязательного job блокирует gate. Артефакты содержат sanitized test reports/logs, версии runtime и image identifiers. Cache ускоряет загрузку, но не скрывает missing lockfile/build input.
12. **Delivery:** README позволяет воспроизвести prerequisites, env setup, startup, health, tests, shutdown и troubleshooting. Перечислены созданные файлы, реально исполненные команды и ограничения. Ни successful trading, ни готовая authentication/worker infrastructure не заявляются.

### Будущие команды приёмки — сейчас не выполнялись

Имена scripts ниже — контракт будущего bootstrap. Точная реализация scripts появляется в PHASE 1; сейчас отсутствие `package.json`/Docker runtime не трактуется как успешная проверка.

```text
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm build
docker compose -f infra/compose.dev.yml config --quiet
docker compose -f infra/compose.dev.yml up --build --wait --wait-timeout 60
pnpm test:smoke
```

`test:smoke` проверяет live/ready, malformed/oversized requests, sanitized logs, dependency outage/recovery и graceful shutdown в выделенной среде. Тестам mutation-функций нет места в bootstrap. `compose config --quiet` валидирует конфигурацию без печати подставленных env secrets. После изменения formatter повторяются check и остальные затронутые проверки.

Clean-install/build gate запускается в отдельном disposable checkout/CI workspace, не через удаление пользовательских файлов. Создание, остановка и очистка test services используют явный уникальный project identifier; destructive volume cleanup разрешён только для созданных этим прогоном ресурсов после проверки target. Runtime результаты, durations, exit codes и stderr фиксируются в отчёте PHASE 1. **На PHASE 0 этот документ завершает планирование; PHASE 1 автоматически не начинается.**
