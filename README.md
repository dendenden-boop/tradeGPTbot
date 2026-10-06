# Crypto Trading Platform

Единый результат аудита фаз 0–3: [итоговый отчёт](docs/audit-phases-0-3.md) — находки, согласованность между этапами, проверенные версии и CI, эксплуатационные ограничения. Решение: **READY FOR PHASE 4**; готовность к production trading ещё не подтверждена.

Многопользовательская платформа ручной и автоматической торговли на Node.js / TypeScript, разрабатываемая по [плану PHASE 0–22](docs/phase-0/implementation-plan.md).

**PHASE 12 — Risk Engine + AMEND в работе**. Реализованы pure policy evaluator, durable kill switches/circuits и общий SQL gate для pause/transport permit. Полный [CI](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37348168824) прошёл на Ubuntu, Windows и real-services/Docker: 2770 distinct tests / 11 isolated deployments, включая 71 Risk unit / 24 PostgreSQL controls и 27 PostgreSQL Order Engine tests. Исправлен подтверждённый cross-adapter WS deadline defect. Fresh deploy/upgrade остаётся GLOBAL PAUSED до явного operator update. `EVALUATED` не является RiskGrant: certified state, atomic reservations/recovery, final current-policy validation и native AMEND lifecycle остаются обязательными. Gate **NOT READY FOR PHASE 13**; LIVE выключен. [Требования](docs/phase-12/requirements.md), [контракты](docs/phase-12/contracts.md), [verification](docs/phase-12/verification.md), [зависимости и эксплуатация](docs/phase-12/dependencies.md).

Hardening PHASE 12 добавил exact position-mode/account-mode proof, currency-qualified liquidity/FX, SQL function allowlist и durable platform/user policies с permanent replay/CAS. Реализованы сборка coordinator evidence, дедупликация order/reservation/hold и расчёт UTC loss/peak с external flows. PostgreSQL UTC journal с immutable batches, permanent event identities и monotonic daily watermark прошёл [полный CI 37442351522](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37442351522): Ubuntu, Windows, 331 native PostgreSQL tests и Docker, включая физический abort/deadline. Coordinator reconstruction теперь принимает bounded loss checkpoint с exact scope/day/freshness и batch/sequence binding, сохраняя external-flow adjustment без повторного вычитания; acceptance этого изменения фиксируется в verification. Production coordinator, atomic reservations/Portfolio bridge, final current-policy dispatch и native AMEND остаются обязательными. Gate **NOT READY FOR PHASE 13**.

**PHASE 11 — Order Engine hardening завершён**, gate **READY FOR PHASE 12** подтверждён полным [CI](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37322120620) и **2662 distinct tests**. Permanent replay теперь возвращает исходный durable order/intent/client identity/command после rules refresh и restart, без новых записей/счётчика; новый stale request остаётся закрытым. Order Engine: 33 unit / 20 real-PostgreSQL tests, десять isolated deployments на обеих OS. AMEND официально перенесён в **PHASE 12** после generic amendment/capability contract согласно [уточнённому roadmap](docs/phase-0/implementation-plan.md); PHASE 11 acceptance покрывает PLACE/CANCEL. [Требования](docs/phase-11/requirements.md), [контракты](docs/phase-11/contracts.md), [verification](docs/phase-11/verification.md), [зависимости и эксплуатация](docs/phase-11/dependencies.md). Acceptance этой записи относится к PHASE 11; LIVE mutations выключены.

**PHASE 10 — Portfolio hardening завершён**, gate **READY FOR PHASE 11** подтверждён полным [CI](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37292228233) и **2609 distinct tests**. Исправлены HTX static balance / двойной unrealized PnL, durable монотонный hold lifecycle и exact TESTNET ownership. Реализованы balances/positions, decimal ledger, scoped valuation и durable reconciliation; 60 Portfolio unit / 17 real-PostgreSQL tests, девять isolated deployments на обеих OS. [Требования](docs/phase-10/requirements.md), [контракты](docs/phase-10/contracts.md), [verification](docs/phase-10/verification.md), [зависимости и эксплуатация](docs/phase-10/dependencies.md). Order/Risk/Paper engines не включены; LIVE mutations выключены. PHASE 11 реализуется отдельно; acceptance этой записи относится к PHASE 10.

**PHASE 9 — Market Data Engine завершена**, gate **READY FOR PHASE 10** подтверждён полным [CI](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37229487039), **2530 distinct tests** и восемью clean deployments. Реализованы public WS pool, shared subscriptions, reconnect/stale, семь UTC candle timeframes и fenced PostgreSQL persistence. Fixture на 300 инструментов / 6000 native frames / три loopback WS connections прошёл без потерь; production load/24h soak не заявлены. [Требования](docs/phase-9/requirements.md), [контракты](docs/phase-9/contracts.md), [фактическая verification](docs/phase-9/verification.md). LIVE mutations выключены; реальная private acceptance — NOT RUN.

Предыдущий gate **READY FOR PHASE 8**: [cross-adapter InstrumentRegistry lifecycle hardening](docs/instrument-registry-lifecycle.md) завершён полным [CI](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37204462284), **2245 tests**, шесть deployments; anti-reuse сохранён. Production Binance/Bybit/OKX требуют обязательный server-injected runtime registry; reference defaults удалены. Acceptance отдельных фаз ниже историческое.

**PHASE 7 — OKX Adapter завершена**, gate **READY FOR PHASE 8** подтверждён после исправления срока действия metadata полным [CI](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37194114436). Отдельный пакет реализует global V5 Spot/USDT SWAP, четыре server profiles, passphrase signing и bounded REST/WS. Прошли **2233 tests**, включая **165 OKX**, шесть clean deployments и **24/24 real public REST/WS probes**. [Требования](docs/phase-7/requirements.md), [контракты](docs/phase-7/contracts.md), [проверки и ограничения](docs/phase-7/verification.md), [зависимости](docs/phase-7/dependencies.md). LIVE mutations выключены; реальная private acceptance — NOT RUN; неизвестные constraints блокируют new-risk admission.

**PHASE 6 — Bybit Adapter завершена**, gate **READY FOR PHASE 7** подтверждён полным [CI](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37188255057). Отдельный пакет реализует Bybit V5 Spot/USDT linear, шесть server profiles, bounded REST/WS и scoped private protocol. Прошли **2068 tests**, пять clean deployments и **36/36 real public REST/WS probes**. [Требования](docs/phase-6/requirements.md), [контракты](docs/phase-6/contracts.md), [проверки и ограничения](docs/phase-6/verification.md), [зависимости](docs/phase-6/dependencies.md). LIVE mutations выключены; реальная private acceptance — NOT RUN.

**PHASE 5 — Binance Adapter завершена**, gate **READY FOR PHASE 6** подтверждён после hardening pagination/filter admission. Отдельный пакет реализует bounded HTTP/WS, public data и private protocol с server authorization boundaries; прошли **1936 tests**, clean deployment четырёх пакетов и все три job [CI](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37146908217). [Требования](docs/phase-5/requirements.md), [контракты](docs/phase-5/contracts.md), [итоговый отчёт и ограничения](docs/phase-5/verification.md). LIVE trading выключен; private exchange acceptance — NOT RUN, неподдерживаемые native возможности явно UNSUPPORTED.

**PHASE 4 — Exchange Core завершена**. Добавлен общий пакет с 33 операциями адаптера, decimal/DTO/capability contracts, versioned instrument registry, bounded streams и тестовым transport. На границе этапа прошли **1372 tests**, clean deployment и все три job [CI](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/36706979599); dependency audit — 0 vulnerabilities. [Контракты](docs/phase-4/contracts.md), [требования](docs/phase-4/requirements.md), [итоговый отчёт](docs/phase-4/verification.md). Исторический gate: **READY FOR PHASE 5**; подтверждённые новые дефекты и их regression tests фиксируются в отчёте PHASE 5.

**PHASE 3 — Authentication завершена**: регистрация, подтверждение почты, вход, сессии, сброс и смена пароля, разграничение ролей БД и архитектура 2FA. [Отчёт проверок](docs/phase-3/verification.md), [HTTP API](docs/phase-3/auth-api.md), [роли и миграция](docs/phase-3/database-security.md), [запуск](docs/phase-3/operations.md). На границе первоначальной реализации прошли 461 тест, clean deployment, Docker и все три job [CI](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/35514994833).

Доступны health endpoints и API авторизации. Exchange Core, Binance, Bybit, OKX, HTX, Market Data, Portfolio, Order Engine и pure Risk policy evaluator существуют как отдельные пакеты; торговые компоненты не подключены к API. Durable Risk gateway, Paper engine, торговые HTTP endpoints, фоновые задания и веб-интерфейс относятся к следующим этапам. Production readiness и реальная нагрузка 300+ инструментов пока не подтверждены.

[PHASE 3 Hardening Audit](docs/phase-3-hardening/verification.md) завершён, включая повторный независимый review: proxy/IP, Redis admission, session concurrency, recovery links, SMTP isolation и database grants. Дополнительно исправлены три P2: опасные предопределённые роли PostgreSQL, конкуренция SMTP readiness с отправками и раскрытие eligibility аккаунта через заполнение почтовой очереди. Прошли **592 теста**, clean deployment и все три job [CI исправлений](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/36526751308), включая Docker smoke. Исторический gate: **READY FOR PHASE 4**; текущая реализация Exchange Core проверяется отдельно.

Завершён [аудит PHASE 0–2 и согласованности этапов](docs/audit-phases-0-2.md): исправлены 9 находок в constraints, durable identities, Decimal boundary, config, упаковке и тестах восстановления; согласованы роли, AMEND/CANCEL и документация. На границе аудита прошли 344 теста и все три job [CI исправлений](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/34765371140). Эти результаты относятся к завершённой базе PHASE 0–2; авторизация проверяется дополнительно.

## Подготовка

Нужны Node.js **24.20.0**, pnpm **11.25.0** и Docker Engine для Linux-контейнеров с командой `docker compose`. Для Windows подойдёт настроенный Docker Desktop в режиме Linux-контейнеров либо доступный Linux Docker Engine. Версии зависимостей и причины выбора описаны в [оценке зависимостей](docs/phase-1/dependencies.md).

Все команды выполняются из корня проекта:

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm env:init
pnpm auth:env:init
```

`env:init` создаёт `.env` с отдельными случайными паролями для PostgreSQL и Redis. `auth:env:init` создаёт `.env.auth` с паролями ограниченных ролей API/auth и секретом CSRF. Секреты не печатаются, существующие файлы не перезаписываются. `.env.example` описывает настройки; его заполнители не являются готовыми паролями. Оба файла исключены из Git и контекста сборки Docker.

В текущем Windows workspace Node и pnpm установлены переносимо в `.tools`, Docker Desktop — для текущего пользователя. Для терминала, открытого до установки:

```powershell
$env:PATH = (Join-Path (Get-Location).Path '.tools\node-v24.20.0-win-x64') + ';' + (Join-Path (Get-Location).Path '.tools\pnpm\node_modules\.bin') + ';' + $env:PATH
$env:PATH = (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin') + ';' + $env:PATH
node --version
pnpm.cmd --version
docker version
```

Если PowerShell блокирует `pnpm.ps1`, используйте `pnpm.cmd` вместо `pnpm` во всех командах. Изменять ExecutionPolicy не требуется. Каталог `.tools` не входит в исходный код; на другой машине Node и pnpm нужно установить отдельно.

## Запуск в Docker

Этот Compose предназначен для локальной разработки. Он применяет миграции, подготавливает ограниченные роли и запускает API, PostgreSQL, Redis и локальный приёмник писем. API опубликован на `127.0.0.1:3000`; SMTP и просмотр тестовых писем — на loopback-портах 1025 и 8025. PostgreSQL/Redis наружу не опубликованы.

```sh
docker compose --env-file .env --env-file .env.auth -f infra/compose.dev.yml config --quiet
docker compose --env-file .env --env-file .env.auth -f infra/compose.dev.yml up --build --wait --wait-timeout 60
```

Первичная загрузка образов и сборка выполняются до ожидания готовности. Статус и остановка:

```sh
docker compose --env-file .env --env-file .env.auth -f infra/compose.dev.yml ps
docker compose --env-file .env --env-file .env.auth -f infra/compose.dev.yml stop
```

Остановка сохраняет volumes PostgreSQL и Redis. Последующий `up --wait` использует сохранённые данные и прежние пароли из `.env`.

## Запуск API в Node.js

Для разработки API вне контейнера запустите только зависимости с дополнительным [Compose-файлом](infra/compose.local.yml). Он публикует PostgreSQL на `127.0.0.1:5432` и Redis на `127.0.0.1:6379`; именно эти адреса записывает `env:init`. Используется отдельный проект `ctp-local`.

```sh
docker compose --env-file .env --env-file .env.auth -p ctp-local -f infra/compose.dev.yml -f infra/compose.local.yml up --build --wait --wait-timeout 60 postgres redis mail-sink
pnpm build
pnpm auth:setup
pnpm dev
```

`dev` собирает пакеты и запускает API; автоматического перезапуска при изменении файлов пока нет. Для запуска уже собранного API используйте `pnpm start`. Остановить API можно через Ctrl+C. После этого остановите зависимости той же Compose-конфигурацией:

```sh
docker compose --env-file .env --env-file .env.auth -p ctp-local -f infra/compose.dev.yml -f infra/compose.local.yml stop
```

При собственных PostgreSQL/Redis настройте раздельные migration/runtime/auth роли согласно [инструкции](docs/phase-3/operations.md). Выберите один способ запуска API: контейнер и локальный процесс по умолчанию занимают одинаковый порт 3000. При изменении порта обновите `AUTH_ORIGIN`; он должен точно совпадать с адресом сайта в браузере.

## Health и конфигурация

```sh
node -e "fetch('http://127.0.0.1:3000/health/live').then(async r => console.log(r.status, await r.json()))"
node -e "fetch('http://127.0.0.1:3000/health/ready').then(async r => console.log(r.status, await r.json()))"
```

`GET /health/live` возвращает 200, пока процесс обслуживает HTTP. `GET /health/ready` возвращает 200 после проверки runtime/auth ролей, версии схемы и Redis `PING`, иначе 503; ответ содержит только статусы зависимостей. Readiness использует рабочие пулы БД. Одновременные запросы используют одну выполняющуюся проверку. `GET /health/auth-email` отдельно проверяет SMTP (200/503): почтовый отказ не мешает запуску API, verified login и работе существующих sessions. При завершении readiness отключается, текущие запросы и подключения закрываются в пределах настроенного окна.

| Настройка               | По умолчанию        | Ограничение                                                                        |
| ----------------------- | ------------------- | ---------------------------------------------------------------------------------- |
| `HOST`, `PORT`          | `127.0.0.1`, `3000` | Порт 1–65535; внутри Compose API слушает `0.0.0.0:3000`                            |
| `DEPENDENCY_TIMEOUT_MS` | 1000                | 1–1000 мс на зависимость                                                           |
| `HEALTH_CACHE_MS`       | 1000                | 0–5000 мс; 0 отключает кэш                                                         |
| `SHUTDOWN_TIMEOUT_MS`   | 10000               | 1–10000 мс                                                                         |
| `BODY_LIMIT_BYTES`      | 16384               | 1–1048576 байт                                                                     |
| `REQUEST_TIMEOUT_MS`    | 10000               | 1–120000 мс                                                                        |
| `CONNECTION_TIMEOUT_MS` | 5000                | 1–30000 мс                                                                         |
| `POSTGRES_POOL_MAX`     | 5                   | 1–20 для отдельного health fixture; сервер использует runtime pool 5 и auth pool 3 |
| `LOG_LEVEL`             | `info`              | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`                       |

Настройки проверяются до создания подключений. Ошибка конфигурации завершает процесс с ненулевым кодом и именами неверных полей без значений секретов. Для `NODE_ENV=staging` и `production` обязательны PostgreSQL `sslmode=verify-full`, Redis `rediss://` и непустые пароли длиной минимум 16 символов без шаблонных значений. PostgreSQL URL допускает только параметры `sslmode` и `application_name`; отключение проверки TLS запрещено. Локальный Compose использует `development` и не является production-конфигурацией.

## Проверки

```sh
pnpm check
pnpm docs:check
pnpm audit:dependencies
pnpm test:runtime
pnpm test:clean
pnpm test:integration
pnpm test:database
pnpm test:smoke
```

`check` выполняет formatter check, ESLint, строгий TypeScript, unit/HTTP tests и сборку. `test:unit` проверяет конфигурацию, логирование, health и lifecycle; `test:http` использует реальные loopback HTTP-соединения и тестовую границу зависимостей. Эти команды не требуют Docker. Для исправления форматирования есть `pnpm format`.

`test:runtime` проверяет собранные health/lifecycle модули отдельным тестовым процессом при недоступных зависимостях. Полный сервер с обязательной авторизацией запускается в `test:database` и `test:integration`: настоящие PostgreSQL, Redis, Argon2id, SMTP и HTTP. В Windows обработчик SIGTERM вызывается через IPC тестового процесса; доставка настоящего Linux SIGTERM проверяется в CI/Docker. `test:clean` проверяет offline frozen install, сборку, production deploy и native Argon2id в новой копии проекта; перед ним требуется заполненный локальный pnpm store.

`test:integration` запускает настоящие PostgreSQL/Redis и проверяет доступность, отдельные отказы и восстановление. Порты выбираются отдельно для каждого прогона и сохраняются при перезапуске сервисов. `test:smoke` собирает образ API и проверяет весь Compose, non-root пользователя, health, логи и остановку. Оба сценария требуют Docker Engine, создают уникальный тестовый проект с собственными паролями и очищают только ресурсы своего запуска. Загрузка образов имеет отдельный лимит 600 секунд, ожидание готовности — 60 секунд. Отсутствие Docker приводит к ошибке проверки. Результаты сценариев сохраняются в `test-results`; наличие тестового файла само по себе не означает успешный прогон.

## Если запуск не удался

| Симптом                                               | Действие                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker` не найден или daemon недоступен              | Подключите Docker Engine для Linux-контейнеров и проверьте `docker version`, `docker compose version`                                       |
| `.env already exists`                                 | Существующий файл сохранён; повторная генерация не нужна                                                                                    |
| `CONFIG_INVALID`                                      | Исправьте указанные имена полей в `.env`; не публикуйте файл или DSN в логах                                                                |
| Live 200, ready 503                                   | Проверьте состояние PostgreSQL/Redis, адреса, пароль и TLS; работающий HTTP-процесс ещё не означает доступные зависимости                   |
| Порт занят                                            | Остановите другой экземпляр API; для контейнера можно изменить `API_PORT`, для Node — `PORT`                                                |
| После изменения `.env` PostgreSQL не принимает пароль | Сохранённый volume использует прежний пароль; верните его или измените пароль в самой БД                                                    |
| Ошибка lockfile/peer dependencies                     | Используйте закреплённые Node/pnpm и `pnpm install --frozen-lockfile`; обновление зависимостей выполняется отдельным проверяемым изменением |

## Документы

| Документ                                             | Содержание                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| [Итоговый аудит PHASE 0–3](docs/audit-phases-0-3.md) | Сводный результат, согласованность этапов и граница допуска   |
| [Архитектура](docs/architecture.md)                  | Границы компонентов и поток данных                            |
| [Отчёт PHASE 1](docs/phase-1/verification.md)        | Выполненные проверки, результаты и открытые ограничения       |
| [Зависимости PHASE 1](docs/phase-1/dependencies.md)  | Версии, лицензии, сопровождение и размер                      |
| [Требования](docs/phase-0/requirements.md)           | Область работ и соответствие заданию                          |
| [Биржевые адаптеры](docs/exchange-adapters.md)       | Матрица возможностей четырёх бирж                             |
| [Market Data](docs/market-data.md)                   | Подписки, свечи, восстановление и нагрузка                    |
| [Execution](docs/execution.md)                       | Идемпотентность, состояния ордера и reconciliation            |
| [Risk Engine](docs/risk-engine.md)                   | Лимиты, резервирование и kill switch                          |
| [База данных](docs/database.md)                      | План сущностей, ограничений и хранения                        |
| [Безопасность](docs/security.md)                     | Threat model и изоляция пользователей                         |
| [Эксплуатация](docs/deployment.md)                   | План мониторинга и восстановления                             |
| [ADR](docs/adr/README.md)                            | Принятые архитектурные решения                                |
| [Отчёт PHASE 0](docs/phase-0/verification.md)        | Завершённое исследование; историческое состояние до bootstrap |
