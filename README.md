# Crypto Trading Platform

Многопользовательская платформа ручной и автоматической торговли на Node.js / TypeScript, разрабатываемая по [плану PHASE 0–22](docs/phase-0/implementation-plan.md).

Текущий этап: **PHASE 3 — Authentication, проверка реализации**. Добавлены регистрация, подтверждение почты, вход, сессии, сброс и смена пароля, разграничение ролей БД и архитектура 2FA. [Отчёт проверок](docs/phase-3/verification.md), [требования этапа](docs/phase-3/requirements.md), [HTTP API](docs/phase-3/auth-api.md), [роли и миграция](docs/phase-3/database-security.md), [запуск](docs/phase-3/operations.md). Этап не считается завершённым до успешного полного прогона проверок и CI.

Доступны health endpoints и API авторизации. Прикладные финансовые writers, биржевые адаптеры, торговля, фоновые задания и веб-интерфейс относятся к следующим этапам. Production readiness и нагрузка 300+ инструментов пока не подтверждены.

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

`GET /health/live` возвращает 200, пока процесс обслуживает HTTP. `GET /health/ready` возвращает 200 после проверки runtime/auth ролей, версии схемы и Redis `PING`, иначе 503; ответ содержит только статусы зависимостей. Readiness использует рабочие пулы БД. Одновременные запросы используют одну выполняющуюся проверку. При завершении readiness отключается, текущие запросы и подключения закрываются в пределах настроенного окна.

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

| Документ                                            | Содержание                                                    |
| --------------------------------------------------- | ------------------------------------------------------------- |
| [Архитектура](docs/architecture.md)                 | Границы компонентов и поток данных                            |
| [Отчёт PHASE 1](docs/phase-1/verification.md)       | Выполненные проверки, результаты и открытые ограничения       |
| [Зависимости PHASE 1](docs/phase-1/dependencies.md) | Версии, лицензии, сопровождение и размер                      |
| [Требования](docs/phase-0/requirements.md)          | Область работ и соответствие заданию                          |
| [Биржевые адаптеры](docs/exchange-adapters.md)      | Матрица возможностей четырёх бирж                             |
| [Market Data](docs/market-data.md)                  | Подписки, свечи, восстановление и нагрузка                    |
| [Execution](docs/execution.md)                      | Идемпотентность, состояния ордера и reconciliation            |
| [Risk Engine](docs/risk-engine.md)                  | Лимиты, резервирование и kill switch                          |
| [База данных](docs/database.md)                     | План сущностей, ограничений и хранения                        |
| [Безопасность](docs/security.md)                    | Threat model и изоляция пользователей                         |
| [Эксплуатация](docs/deployment.md)                  | План мониторинга и восстановления                             |
| [ADR](docs/adr/README.md)                           | Принятые архитектурные решения                                |
| [Отчёт PHASE 0](docs/phase-0/verification.md)       | Завершённое исследование; историческое состояние до bootstrap |
