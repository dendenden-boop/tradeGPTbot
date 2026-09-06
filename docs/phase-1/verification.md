# Проверка PHASE 1 — Project Bootstrap

Обновлено: **2026-09-06**, проверки выполнялись 5–6 сентября. Статус этапа: **OPEN — локальная контейнерная приёмка пройдена, ожидается удалённый CI**. После разрешения пользователя установлены Docker Desktop и WSL 2; реальные integration и smoke завершились успешно. PHASE 2 не начата: для полного закрытия [плана приёмки](../phase-0/implementation-plan.md) ещё требуется запуск GitHub Actions в выбранном пользователем репозитории.

## Реализовано

Monorepo содержит три рабочих пакета: `@ctp/config`, `@ctp/logger`, `@ctp/api`. Конфигурация проходит Zod-валидацию до открытия сокетов; ошибки содержат только имена полей. Логирование выдаёт JSON с безопасной классификацией ошибок и requestId. API предоставляет `/health/live` и `/health/ready`, общие ошибки, ограничения входящих запросов и управляемое завершение процесса.

Readiness использует реальные драйверы `pg`/`ioredis`: PostgreSQL `SELECT 1 AS ok` и Redis `PING`. Проверки идут параллельно; одновременные HTTP-запросы делят одну проверку. Дедлайн каждой зависимости не превышает 1000 мс, кэш — 5000 мс. Зависшая операция не порождает новые перекрывающиеся попытки. Redis работает без offline queue, автоматического reconnect и дополнительных `INFO`-проверок. Закрытие ожидает фактическое окончание Redis-подключения.

Созданы multi-stage Dockerfile с non-root runtime, Compose для локальной разработки и изолированных тестов, Linux/Windows CI. Схема БД, миграции, авторизация, workers, биржевые соединения, финансовые endpoints и интерфейс пользователя в этот этап не входят.

## Среда и воспроизводимость

Проверки выполнены в Windows 11 Pro x64 26200.9278, workspace `C:\Users\Admin\Documents\vscode`, с переносимыми Node.js **24.20.0** и pnpm **11.25.0**. Инструменты находятся в игнорируемой `.tools`, pnpm store — в `.pnpm-store`. Системный Node и ExecutionPolicy Windows не менялись. После разрешения пользователя установлены **Docker Desktop 4.89.0** для текущего пользователя и **WSL 2.7.13.0**. Linux Engine **29.7.2**, Compose **5.5.0**, WSL kernel **6.18.33.2-2**, контекст `desktop-linux`. VirtualMachinePlatform включён; установщики завершились с exit 0, перезагрузка не потребовалась. Команды подготовки PATH приведены в [README](../../README.md).

Официальный архив Node сверялся по SHA-256: `6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba`. Первичная проверка YAML выполнялась переносимым Compose **5.5.0**, SHA-256 `51e1e61195f3616896265487ed64551095f3bd27ac7fbd5758d3538c3bfa1b19`, сверенным с официальным `checksums.txt`. Источники: [Node 24.20.0](https://nodejs.org/dist/v24.20.0/), [Compose 5.5.0](https://github.com/docker/compose/releases/tag/v5.5.0).

Установщики дополнительно проверены через Authenticode: Docker Inc и Microsoft Corporation, статус Valid. SHA-256 Docker Desktop: `854626704af28a160d5af68b96b3e32eacf08ab397ce6c12eb02a04788d73681`; WSL MSI: `a3505a50f4cc585551d11d9de824ba4375448d7a68f2e71d3fb315fa986fc754`. Источники: [Docker release/checksum](https://docs.docker.com/desktop/release-notes/#4890), [WSL 2.7.13](https://github.com/microsoft/WSL/releases/tag/2.7.13). Docker расположен в `%LOCALAPPDATA%\Programs\DockerDesktop`, WSL — `C:\Program Files\WSL`. Файлы установщиков и журналы сохранены локально в игнорируемой `.tools/installers`.

`pnpm test:clean` создал новую копию исходников в `.cache/clean-dWD4S6`, без `node_modules` и `dist`, выполнил offline frozen install из локального store, сборку всех трёх пакетов, production deploy и разрешение runtime imports из deployment. SHA-256 lockfile до и после установки совпал: `3833dbc9968d0376378b7c2909b8990f56264f7cc3e10e346c8d663767a7610f`. Это проверка свежего дерева исходников на Windows. Linux frozen install/build также выполнен при первой сборке Docker-образа; GitHub-hosted clean checkout подтверждается отдельным CI.

## Выполненные команды

| Проверка / команда                                                              | Фактический результат                                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm install --offline` после первоначальной загрузки зависимостей             | PASS, exit 0; разрешён только postinstall `esbuild@0.28.2`                                   |
| `pnpm format`                                                                   | PASS, exit 0; исходники и новые конфигурации отформатированы                                 |
| `pnpm check`                                                                    | PASS, exit 0; formatter, ESLint, typecheck, unit/HTTP suites, build                          |
| `pnpm format:check` в составе `check`                                           | PASS, exit 0                                                                                 |
| `pnpm lint` в составе `check`                                                   | PASS, exit 0; ноль warnings                                                                  |
| `pnpm typecheck` в составе `check`                                              | PASS, exit 0; strict flags, `skipLibCheck: false`                                            |
| `pnpm test:unit` в составе `check`                                              | PASS: **92 теста**, четыре файла                                                             |
| `pnpm test:http` в составе `check`                                              | PASS: **13 тестов**, реальные loopback HTTP-соединения                                       |
| `pnpm build` в составе `check`                                                  | PASS: config, logger и API, exit 0                                                           |
| `pnpm test:runtime`                                                             | PASS, exit 0; отдельный процесс собранного API, настоящие драйверы и неотвечающие TCP-сокеты |
| `pnpm test:clean`                                                               | PASS, exit 0; frozen install, build, production deploy и import resolution                   |
| `pnpm audit:dependencies`                                                       | PASS, exit 0; `No known vulnerabilities found` на дату проверки                              |
| `pnpm env:init`                                                                 | PASS, exit 0; создан локальный `.env`, значения не печатались                                |
| Повторный запуск `scripts/init-env.mjs` с проверкой содержимого                 | Ожидаемый exit 1; существующий `.env` побайтово сохранён                                     |
| Compose 5.5.0 `config --quiet`: development, test, development + local override | PASS, все три варианта exit 0; использованы фиктивные env-значения без запуска сервисов      |
| `pnpm test:integration`                                                         | PASS, exit 0: 3 теста с реальными PostgreSQL/Redis; два последовательных чистых прогона      |
| `pnpm test:smoke`                                                               | PASS, exit 0: production image, non-root, readiness, outage/recovery, secrets и SIGTERM      |
| Linux lint/typecheck/unit/HTTP/runtime в Docker                                 | PASS, все команды exit 0; отдельный контейнер и настоящая доставка OS SIGTERM                |
| GitHub Actions                                                                  | PENDING: репозиторий dendenden-boop/tradeGPTbot выбран, удалённый запуск готовится           |

Unit suites: config — 66, logger — 15, health — 5, lifecycle — 6. Всего с HTTP — **105 успешных тестов**, плюс **3 реальных dependency integration теста** (108 уникальных сценариев; повторения на другой ОС не удваивают это число). HTTP suite подменяет только границу зависимостей; она не выдаётся за проверку PostgreSQL/Redis. Ноль найденных тестов настроен как ошибка.

В runtime-прогоне 64 одновременных readiness-запроса вернули 503 за **565 мс** всей группой; максимум одновременно наблюдавшихся dependency sockets — **2**. Liveness оставался 200 и сам не открывал подключений к зависимостям. Завершение процесса заняло **29 мс**. Эти измерения относятся к конкретному локальному прогону, не являются нагрузочным benchmark и не подтверждают 300 инструментов.

Windows не доставляет дочернему Node-процессу POSIX SIGTERM как Linux. Поэтому только тестовый `runtime-child.mjs` вызывает зарегистрированное событие SIGTERM через IPC; production entrypoint такого управления не содержит. Доставка настоящего OS SIGTERM подтверждена Docker smoke: exit 0, `api_stopping`/`api_stopped`, без fatal events; остановка контейнера вместе с вызовом Compose заняла **543 мс**. Приложение в контейнере выполнило shutdown между отметками логов за 3 мс.

Проверенный runtime image ID: `sha256:1d0089544d90489d8bc39ec503d793f13025f63509d28423d9c89880d659b549`. Дополнительный запуск с `--read-only --network none` подтвердил UID **1000**, отсутствие `/app/.env` и установленных TypeScript/Vitest/ESLint в runtime. `docker image inspect` вернул Size **83563830 байт**. Smoke также проверил реальные отказы и восстановление обеих зависимостей, отсутствие тестовых паролей в HTTP/логах/image config и очистку своего проекта.

`pnpm docs:check` также завершился с exit 0: 19 UTF-8 документов, 81 локальная ссылка, 34 таблицы и 16 блоков кода. Финальный `pnpm format:check` прошёл после добавления отчёта.

Машинные результаты находятся в игнорируемом `test-results/`: `unit.json`, `http.json`, `runtime.json`, `clean-install.json`, `integration.json`, `smoke.json`. Integration/smoke теперь содержат **PASS**; прежние причины неуспеха разобраны ниже. Cleanup failure переводит результат Docker-runner в FAIL.

Linux lint, strict typecheck, 92 unit + 13 HTTP tests и compiled runtime прошли в отдельном контейнере с отключённой внешней сетью. Параметры pnpm соответствовали build stage: `--config.store-dir=/pnpm/store --config.verify-deps-before-run=error`. 64 readiness-запроса: **579 мс**, максимум **2** dependency sockets; завершение по настоящему OS SIGTERM: **15 мс**. Отчёты: `test-results/linux-checks.json`, `linux-checks-unit.json`, `linux-checks-http.json`, `linux-checks-runtime.json`. Начальное несовпадение store/CI-настроек тестового контейнера исправлено в окружении runner, проверки оставлены включёнными. Тестовые контейнеры удалены.

## Исправления по результатам проверок

- Первичная установка остановилась на несовместимости TypeScript 7 с peer-range линтера и декларациях Vitest 5/Vite 8. Выбраны TypeScript 6.0.3, Vitest 4.1.11 и Vite 7.3.6; строгая проверка типов библиотек сохранена. Версии и лицензии разобраны в [оценке зависимостей](dependencies.md).
- pnpm 11 потребовал явное разрешение postinstall esbuild. Код установки просмотрен; разрешена одна точная версия через `allowBuilds`, устаревшие настройки удалены. Источник поведения: [изменения pnpm 11](https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.0.md).
- esbuild не смог загрузить конфигурацию из-за ограничений чтения родительских каталогов в sandbox. Тесты повторены с разрешённым доступом вне sandbox; код и тестовые проверки ради этого не ослаблялись.
- HTTP-тесты и review выявили путь Fastify для некорректного URL, обходящий обычный error handler. Добавлены безопасный `frameworkErrors`, заголовки, completion log и регрессия с секретом в malformed URL.
- Проверка остановки обнаружила преждевременное ожидание закрытия listening socket, затем настоящее удержание keep-alive соединения после завершения активного запроса. Исправлены ожидание в тесте и `Connection: close` во время drain; тест сохранил проверку успешного завершения запроса.
- Удалён сырой URL из сериализатора request; допускается только серверный шаблон маршрута. Добавлена проверка секрета в pathname. Ошибки не сериализуют message, stack, cause или body.
- Review выявил лишний Redis `INFO` и скрытые таймеры при loading. Для health-клиента используется непосредственно `PING`; повторный disconnect объединён, его ожидание включено в lifecycle. Runtime-тест повторён успешно.
- Первая проверка production deploy пыталась использовать новый относительный store и повторно обратиться к сети. Добавлены явный общий store и offline deploy в тесте/Dockerfile. Повторная чистая установка, сборка и упаковка прошли.
- Сбор вывода дочерних процессов теперь завершается по `close`, чтобы дождаться stdout/stderr. Docker-отчёты окончательно записываются после cleanup, а время shutdown измеряется непосредственно вокруг остановки.
- Первые integration/smoke команды не запускались без Docker. После установки Docker первый реальный прогон обнаружил неэкспортируемый subpath `vitest/vitest.mjs`; CLI теперь определяется относительно публичного `vitest/package.json`.
- После первого успешного SELECT/PING тест восстановления обнаружил изменение динамических host-портов Docker при stop/start. Подтверждён пример PostgreSQL: 52424 → 56406; Redis: 52423 → 56418. Runner теперь выбирает свободные loopback-порты для конкретного прогона и передаёт их явными bindings; тест дополнительно проверяет сохранение портов. Если порт успеет занять другой процесс, Compose завершит прогон ошибкой. Production health и 6500-мс окно не ослаблялись.
- Загрузка PostgreSQL/Redis вынесена в отдельный `compose pull` с лимитом 600 секунд. Она не расходует 60-секундный бюджет готовности уже загруженных сервисов.

- Первый удалённый CI прошёл на Linux, но Windows checkout заменил LF на CRLF, и formatter отклонил 53 файла. В `.gitattributes` закреплены LF для текстовых файлов; проверка форматирования сохранена. [Первый прогон](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/34019129930).

- Во втором CI обе ОС прошли, но предустановленный Compose **2.38.2** GitHub runner не поддержал `start --wait`. Перезапуск теперь использует обычный [`compose start`](https://docs.docker.com/reference/cli/docker/compose/start/); готовность проверяется непосредственно через API в прежнем окне 6500 мс, которое теперь включает запуск зависимости без предварительного ожидания Docker healthcheck. [Прогон с выявленной несовместимостью](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/34032355504).

## Security и границы проверки

Проверены fail-fast env, отсутствие sentinel credentials в ответах и логах, вложенные ошибки, заголовки и cookies, URL query/path, malformed JSON, prototype poisoning, oversized body, unsupported content type, неизвестные маршруты, handler exception, client disconnect, конфликт порта, повторные start/stop и зависшее закрытие. Таймауты, pool size, request body, requestId и кэш ограничены. Закрытие одной зависимости не препятствует попытке закрыть вторую, даже если драйвер синхронно бросил ошибку.

Дополнительный compiled runtime-сценарий закрывает настоящий stdout pipe дочернего API после появления startup-логов. Затем 16 запросов liveness должны вернуть 200, а остановка — exit 0 в установленный deadline; stderr проверяется на необработанные ошибки и credentials. Pino прекращает запись в закрытый канал, поэтому сохранность последующих логов этим сценарием не обещается. Исчерпание PostgreSQL pool через health-запросы исключается одной общей выполняющейся проверкой и минимальным pool size 1; параллельный runtime-прогон проверяет предел подключений.

Pino redaction дополняет явно выбранные поля логирования; она не объявляется универсальным фильтром произвольных объектов любой глубины. Новые места логирования должны передавать статические сообщения и безопасные поля. Денежных вычислений и реальных биржевых вызовов нет.

`.env` исключён из Git и Docker build context; пароли передаются только при runtime. Образы закреплены digest, GitHub Actions — commit SHA. Проверены границы тестовых project names, очистка созданных контейнеров/volumes, runtime UID, подключения к живым PostgreSQL/Redis, outage/recovery и Linux SIGTERM. Проверка image config и runtime filesystem не является полным forensic-аудитом всех слоёв. Production TLS-handshake и удалённый GitHub Actions пока не проверены. Dependency audit не заменяет эти проверки.

## Файлы этапа

Созданы исходники, тесты и конфигурации:

```text
.gitattributes
.dockerignore
.env.example
.gitignore
.node-version
.nvmrc
.prettierignore
.prettierrc.json
.github/workflows/ci.yml
eslint.config.mjs
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
tsconfig.base.json
tsconfig.json
vitest.shared.ts
vitest.unit.config.ts
vitest.http.config.ts
vitest.dependencies.config.ts
apps/api/package.json
apps/api/tsconfig.build.json
apps/api/src/app.ts
apps/api/src/health.ts
apps/api/src/lifecycle.ts
apps/api/src/server.ts
apps/api/test/health.unit.test.ts
apps/api/test/http.integration.test.ts
apps/api/test/lifecycle.unit.test.ts
packages/config/package.json
packages/config/tsconfig.build.json
packages/config/src/index.ts
packages/config/test/config.unit.test.ts
packages/logger/package.json
packages/logger/tsconfig.build.json
packages/logger/src/index.ts
packages/logger/test/logger.unit.test.ts
infra/Dockerfile
infra/compose.dev.yml
infra/compose.local.yml
infra/compose.test.yml
scripts/check-runtime.mjs
scripts/docker-test-utils.mjs
scripts/init-env.mjs
scripts/runtime-child.mjs
scripts/test-clean-install.mjs
scripts/test-integration.mjs
scripts/test-runtime.mjs
scripts/test-smoke.mjs
tests/dependencies.integration.test.ts
docs/phase-1/dependencies.md
docs/phase-1/verification.md
```

`README.md` обновлён инструкциями bootstrap. Formatter изменил только оформление ранее созданных `scripts/check-docs.mjs`, `docs/adr/README.md`, `docs/architecture.md`, `docs/database.md`, `docs/deployment.md`, `docs/exchange-adapters.md`, `docs/execution.md`, `docs/market-data.md`, `docs/risk-engine.md`, `docs/security.md`. Исторические документы `docs/phase-0` сохранены как отчёт предыдущего этапа. Рабочие `.env`, `.tools`, `.pnpm-store`, `.cache`, `node_modules`, `dist`, `test-results` не предназначены для коммита.

## Осталось до закрытия

Пользователь разрешил загрузку исходников в [dendenden-boop/tradeGPTbot](https://github.com/dendenden-boop/tradeGPTbot). Подготовлены локальный Git и remote. Осталось подтвердить успешный Linux/Windows workflow в GitHub Actions. Локальные команды и Linux-контейнеры не выдаются за удалённый CI. До его успешного результата этап остаётся открытым. Следующий этап после приёмки — PHASE 2: схема БД, migrations, constraints/indexes и проверяемый development seed.
