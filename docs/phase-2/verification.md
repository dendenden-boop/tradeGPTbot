# PHASE 2 — проверка базы данных

Дата: **2026-09-08**. Статус: **PHASE 2 завершена**. Реализация `1d4bbcfb056216fb22b42d4ea90cf55be43069d4` прошла все локальные проверки и три job [GitHub CI](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/34228676860): Ubuntu 24.04, Windows 2025 и реальные сервисы/Docker smoke. Базовая версия предыдущей фазы — `c1b9879`. Этот отчёт относится к схеме и инфраструктуре БД; auth и торговые сервисы следующих фаз не реализованы.

## Реализовано

Создан пакет `@ctp/database`: Prisma ORM 7.10.0, PostgreSQL adapter, 59 моделей (28 обязательных и 31 вспомогательная), две SQL migrations, типизированный tenant transaction helper, проверка decimal strings и development seed. Все 61 денежных поля используют NUMERIC без округляющего typmod и явные CHECK диапазона/scale/знака. Время — timestamptz(3), IDs — UUID и bounded external strings.

Составные FK согласуют tenant, account, mode и родительские записи. PAPER не требует биржевого connection и не может иметь ExchangeConnection; paper extensions используют общие Order/Position. RLS с USING/WITH CHECK и FORCE включён для всех 48 tenant/user таблиц. Runtime роль отделена от владельца и секретных auth/credential таблиц. Helper отвергает привилегированные роли, включая опасное членство, проверяет DSN/TLS, устанавливает transaction-local tenant context, ограничивает запросы и закрытие pool, возвращает безопасные ошибки без raw SQL/DSN.

Ledger требует сбалансированные entries по каждому активу в одной транзакции и фиксирует закрытие внутренним SQL seal. Пустые, односторонние, несбалансированные или поздно добавленные postings отклоняются. История risk policy/decision/event, intent, fill и другое evidence защищены от UPDATE/DELETE. Idempotency identity/request hash неизменяемы при сохранении возможности записать результат обработки. Работающие финансовые writers и correction API появятся в PHASE 10–14.

Свечи имеют monthly/default partitions. Для active orders и running strategies добавлены вычисляемые PostgreSQL boolean predicates и partial indexes, пригодные для RLS. Seed создаёт только suspended пользователя без пароля, disabled PAPER account и inactive fixture instrument/rules, сохраняя пользовательские изменения при повторах.

## Выполненные проверки

| Команда / сценарий                         | Результат                                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:validate`, Prisma format/generate | PASS, exit 0                                                                                                                 |
| `pnpm build`                               | PASS, exit 0; генерация клиента и четыре workspace package builds                                                            |
| `pnpm format`                              | PASS, exit 0                                                                                                                 |
| `pnpm lint`                                | PASS, exit 0, без предупреждений                                                                                             |
| `pnpm typecheck`                           | PASS, exit 0; strict и skipLibCheck=false                                                                                    |
| `pnpm test:unit`                           | PASS, 151 тест: 92 bootstrap + 59 database/CLI boundary                                                                      |
| `pnpm test:http`                           | PASS, 13 тестов реальных loopback HTTP-соединений                                                                            |
| `pnpm test:runtime`                        | PASS, exit 0: fail-fast config, liveness, driver timeouts, coalescing, shutdown, закрытый stdout, безопасные логи            |
| `pnpm test:database`                       | PASS, 47 PostgreSQL-тестов + fresh/repeat/upgrade/reset                                                                      |
| `pnpm test:clean`                          | PASS, frozen offline install из чистых исходников, build, production deploy и изолированные imports API/DB                   |
| `pnpm audit --json`                        | PASS, exit 0; 0 info/low/moderate/high/critical в итоговом графе                                                             |
| `pnpm docs:check`                          | PASS, UTF-8, структура Markdown и локальные ссылки                                                                           |
| `pnpm test:integration`, `pnpm test:smoke` | PASS, exit 0: 3 service recovery + 47 DB tests; non-root Docker API, health/outages/recovery, SIGTERM и безопасные логи      |
| GitHub CI                                  | PASS, все 3 job, [run 34228676860](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/34228676860), commit `1d4bbcf` |

В PostgreSQL-тестах проверены реально конкурирующие транзакции intent/fill/inbox, один победитель CAS, rollback outbox, read/write tenant isolation, чужие и несовместимые FK, unsafe role rejection, numeric boundaries напрямую через SQL, stale SQL timeout, повторный/concurrent seed и идемпотентное закрытие helper. Ledger покрывает commit-time rollback, отдельный баланс каждого актива, early seal через SET CONSTRAINTS, late append, конкурентность, stale REPEATABLE READ, непривилегированный доступ к internal schema и signed margin balances.

Upgrade использует настоящую первую migration с уже сохранёнными User/account/ledger records, затем вторую. Проверяется точное сохранение decimal postings, создание seal и запрет поздней дописки. Fresh DB получает обе миграции, повторный deploy не имеет эффекта. Reset работает только на DB текущего случайного Docker project после проверки имени и опубликованного loopback port; затем история применяется заново и отсутствие старых данных проверяется SQL. Unit guards отдельно отвергают невыделенный project, production environment, неправильную БД/адрес и malformed URL до обращения к Docker/SQL.

Локальные машинные отчёты находятся в ignored `test-results`: `unit.json`, `http.json`, `runtime.json`, `database.json`, `database-tests.json`, `database-query-plans.json`, `clean-install.json`, `audit-phase2.json`. Это результаты выполненных команд, а не замена повторяемым тестам в исходниках. CI сохраняет отчёты как artifacts с ограниченным сроком хранения.

## EXPLAIN и границы измерений

Использовались 2 400 orders/fills/strategies/outbox records и 3 000 candles. Активные orders, running strategies и ready outbox занимали по 24 строки; это synthetic selective fixture, не нагрузочный тест биржевой торговли. Запросы выполнены непривилегированным runtime под RLS с `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, `enable_seqscan=on`.

| Запрос             | Подтверждённый индекс                         | Строк результата |
| ------------------ | --------------------------------------------- | ---------------- |
| Order history      | `order_tenantId_createdAt_id_idx`             | 20               |
| Active orders      | `order_active_account`                        | 24               |
| Fill history       | `fill_tenantId_instrumentId_timestamp_id_idx` | 20               |
| Running strategies | `strategy_running_tenant`                     | 20               |
| Candle range       | индекс соответствующей monthly partition      | 20               |
| Ready outbox       | `outbox_ready`                                | 20               |

Проверены pruning для September/October/default partitions и keyset timestamp+UUID при одинаковом timestamp с двумя конкурентными inserts: все 2 400 исходных IDs обходятся без пропусков и дублей. Абсолютное время этих малых warm-cache запросов не является production SLO. 300+ instruments, burst/soak, restore/PITR, multi-instance failover и production TLS deployment остаются будущими этапами.

## Найденные и исправленные проблемы

- Первоначальный SQL generator ошибочно распознал `IntentOrigin` как Int. Уточнена граница типа; проверены все 61 decimal constraints и реальные миграции.
- Prisma migrate diff без datasource metadata завершался успешно без SQL. Генерация initial проверена по реальному SQL-файлу и применению, как описано в [operations](operations.md).
- PostgreSQL не мог вывести единый тип параметра, использованного одновременно как UUID и external text ID. Fixture SQL теперь содержит явные casts.
- Ограничение reserved<=total не допускало signed margin balances. Удалено неподтверждённое предположение о соотношении полей; индивидуальные диапазоны/знаки сохранены.
- Добавлены неизменяемость risk evidence, immutable idempotency identity и deferred ledger conservation/seal, включая upgrade существующих postings.
- На реальном плане enum filters под RLS не использовали ожидаемые индексы. Добавлены stored generated flags; тесты подтверждают автоматическое изменение, невозможность подделать flag и фактическое использование индексов. RLS и LEAKPROOF flags не ослаблялись.
- Аудит выявил три advisories в зависимостях Prisma CLI. Введены проверенные точечные overrides deepmerge-ts 8.0.0 / mysql2 3.23.1; повторный audit чистый.
- Clean deploy включал необязательные Prisma CLI/TypeScript peers; исправлена metadata в точном readPackage hook. Теперь DB production deploy содержит 23 пакета, проходит импорт без ancestor node_modules fallback и проверку PostgreSQL WASM. Строгие supply-chain проверки сохранены.
- Один runtime запуск под параллельной нагрузкой превысил исходный deadline; отдельный повтор прошёл без изменения лимита. Docker после паузы имел остановившийся WSL backend; штатный restart восстановил Engine без сброса volumes. Failed прогоны не объявлялись успешными.

## Файлы и ограничения

Основные новые файлы: [schema](../../packages/database/prisma/schema.prisma), [initial migration](../../packages/database/prisma/migrations/202609070001_initial/migration.sql), [integrity migration](../../packages/database/prisma/migrations/202609070002_integrity/migration.sql), [migration lock](../../packages/database/prisma/migrations/migration_lock.toml), [Prisma config](../../packages/database/prisma.config.ts), [package manifest](../../packages/database/package.json), [build config](../../packages/database/tsconfig.build.json), [DB helper](../../packages/database/src/index.ts), [decimal boundary](../../packages/database/src/decimal.ts), [seed](../../packages/database/src/seed.ts).

Новые проверки: [database integration](../../packages/database/test/database.integration.test.ts), [ledger](../../packages/database/test/ledger.integration.test.ts), [query plans](../../packages/database/test/query-plans.integration.test.ts), [client unit](../../packages/database/test/client.unit.test.ts), [decimal unit](../../packages/database/test/decimal.unit.test.ts), [seed guard](../../packages/database/test/seed-cli.unit.test.ts), [runner guard](../../packages/database/test/runner-guard.unit.test.ts), [Vitest config](../../vitest.database.config.ts), [DB runner](../../scripts/test-database.mjs), [seed CLI](../../scripts/seed-development.mjs), [pnpm hook](../../.pnpmfile.mjs).

Изменены `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.shared.ts`, `eslint.config.mjs`, `.gitignore`, `.prettierignore`, `.dockerignore`, `.env.example`, [integration runner](../../scripts/test-integration.mjs), [clean install runner](../../scripts/test-clean-install.mjs), [CI workflow](../../.github/workflows/ci.yml), [README](../../README.md), [database design](../database.md), [ADR-005](../adr/README.md) и документы текущей фазы: [requirements](requirements.md), [dependencies](dependencies.md), [operations](operations.md), этот отчёт. Generated Prisma code не коммитится; `.env`, local tools, caches и тестовые данные не публикуются.

Оставшиеся границы: приложение имеет health endpoints; нет регистрации, credential encryption/signing, внешнего dispatch, risk admission, ledger/position writers, outbox relay, market ingest workers или торговли. PUBLIC CapabilitySnapshot хранит только общие возможности; account-specific permissions относятся к tenant-owned connection. Decimal arithmetic и точность промежуточных расчётов проверяются с writers, сейчас реализовано точное хранение/строковый ввод. SQL-only constraints, generated fields, RLS, internal seal и partitions требуют ручного сохранения в будущих migrations; Prisma diff не является полным drift audit.
