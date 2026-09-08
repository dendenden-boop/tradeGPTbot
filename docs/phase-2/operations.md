# PHASE 2 — работа с базой данных

Схема находится в [schema.prisma](../../packages/database/prisma/schema.prisma), SQL-история — в [initial](../../packages/database/prisma/migrations/202609070001_initial/migration.sql) и [integrity](../../packages/database/prisma/migrations/202609070002_integrity/migration.sql). Прикладные auth, ledger и trading writers вводятся в последующих фазах. Наличие таблиц не включает торговлю.

## Сборка и миграции

Из корня проекта:

```sh
pnpm install --frozen-lockfile
pnpm db:validate
pnpm build
```

Генерация Prisma Client входит в сборку. Generated TypeScript не коммитится; production package содержит скомпилированный клиент и runtime query compiler. Для generate/validate подключение к БД не требуется.

Для применения миграций задайте `DATABASE_MIGRATION_URL` в окружении процесса, затем выполните `pnpm db:migrate`. Команда не заимствует `DATABASE_URL` и не вызывает reset. DDL-роль должна владеть схемой, создавать таблицы, функции и роли. Пароль не записывается в migration. Не передавайте DDL-учётную запись в runtime helper.

Локальные PostgreSQL/Redis запускаются по инструкции [README](../../README.md). Для этого Compose имя development DB — `ctp`, адрес — `127.0.0.1:5432`; пароль задаёт существующий `.env`. Prisma CLI самостоятельно этот файл не загружает: передайте URL через окружение своего терминала или менеджер секретов. Не вставляйте DSN в журнал CI.

## Роли и tenant context

Миграция создаёт групповые роли `ctp_api`, `ctp_signer`, `ctp_ingest` без LOGIN и паролей. Отдельные LOGIN-роли с разными случайными паролями выдаёт администратор окружения. Runtime LOGIN получает членство в `ctp_api`, без superuser, BYPASSRLS, CREATE ROLE/DB, владения таблицами или CREATE на public schema. Helper проверяет и опасные унаследованные роли.

| Роль            | Разрешения                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------- |
| Migration owner | DDL, управление grants и миграциями; не используется приложением                            |
| `ctp_api`       | Tenant data через RLS; shared lookup только SELECT; immutable evidence только SELECT/INSERT |
| `ctp_signer`    | SELECT зашифрованных credentials с tenant RLS; не выдаётся обычному API                     |
| `ctp_ingest`    | Public instrument/market facts; без tenant финансов и credentials                           |

`User` для API имеет SELECT только безопасных столбцов. Session, verification/reset/recovery tokens, 2FA и encrypted credentials недоступны `ctp_api`. Поэтому запрос пользователя через Prisma должен явно выбирать разрешённые поля.

`CapabilitySnapshot` содержит общие проверенные возможности exchange/market/mode/region/accountMode, без конкретной учётной записи. Частные permissions конкретного подключения хранятся в tenant-owned `ExchangeConnection`; их нельзя помещать в public capability JSON.

```ts
import { createDatabase } from '@ctp/database';

const database = await createDatabase({
  connectionString: runtimeConnectionString,
  environment: 'production',
});
try {
  const accounts = await database.withTenant(authenticatedUserId, (transaction) =>
    transaction.exchangeAccount.findMany(),
  );
} finally {
  await database.close();
}
```

`authenticatedUserId` поступает из доверенного principal будущего auth service. Это не tenant ID из тела HTTP-запроса: RLS не заменяет аутентификацию. Helper устанавливает transaction-local context, применяет Serializable isolation и не повторяет операции автоматически. Внешний HTTP/WS внутри callback не выполняется. Ошибки возвращаются без SQL/DSN; известные constraint/serialization codes сохраняются. В staging/production обязательны `sslmode=verify-full` и пароль минимум 16 символов.

## Development seed

`pnpm db:seed` загружает `.env` и требует явно заданные `NODE_ENV=development` и `DATABASE_MIGRATION_URL`. Допустим только loopback PostgreSQL с именем БД `ctp`, без параметров URL. Неизвестное имя, удалённый адрес, staging/production или отсутствующий URL приводят к отказу до записи.

Seed создаёт suspended user без пароля, disabled PAPER account и inactive synthetic instrument с пометкой fixture. Действующие sessions, credentials, LIVE grants и торговые операции не создаются. Повторный запуск сохраняет существующие значения; конкурентные запуски сериализуются транзакционной advisory lock. Чистый тестовый runner вызывает ту же функцию на своей отдельной БД.

## Проверки и дальнейшие миграции

Ledger header и все его entries записываются одной транзакцией. Deferred constraints при commit требуют минимум две записи для каждого актива и точную сумму 0. Внутренняя SQL-таблица `ctp_internal.ledger_seal` фиксирует закрытие posting; поздние INSERT в него запрещены. Это служебная таблица enforcement, отдельно от 59 domain models Prisma. Она и trigger functions недоступны runtime; служебные функции имеют фиксированный search_path и явно сверяют tenant context. При `SET CONSTRAINTS ALL IMMEDIATE` posting закрывается сразу, последующее добавление entries также отклоняется. Исправления — новая ledger transaction с correction reference, без изменения старых записей. Миграция проверяет и закрывает существующие postings; несбалансированные старые данные блокируют upgrade.

`pnpm test:database` создаёт уникальный Docker project и две отдельные test DB: fresh и upgrade. Применяется вся история, повторный deploy, upgrade с первой миграции с данными, реальные SQL-тесты с непривилегированной ролью и reset только созданной runner БД. Имя project и опубликованный loopback port проверяются до создания/удаления test DB. Пользовательские volumes не сбрасываются. `pnpm test:integration` включает эти проверки вместе с PostgreSQL/Redis failure/recovery.

Prisma schema не выражает RLS, SQL CHECK, partial indexes, triggers и partition layout. Следующую миграцию нужно проверять по SQL и PostgreSQL catalog, сохраняя эти объекты. `db push` и автоматический destructive downgrade не являются рабочим процессом. Используйте expand/contract и отдельный forward fix; после опубликования migration её содержимое не переписывается.

Для read-only `prisma migrate diff` в Prisma 7.10 потребовался datasource metadata URL даже при `--from-empty --to-schema`: без него CLI завершался с кодом 0, не создавая SQL. При генерации initial использован отдельный command-scoped нерабочий loopback URL; наличие и размер SQL проверены, затем SQL применён на реальном PostgreSQL. Этот обход не добавляет fallback URL к deploy или runtime.

`Candle` разделена по UTC openTime: начальные месяцы September/October 2026 и default partition. Default сохраняет данные за пределами подготовленных месяцев; перенос таких строк при добавлении новой partition требует отдельной migration/maintenance операции. Автоматический partition maintenance и retention worker пока не реализованы.

Реальные EXPLAIN выявили ограничение enum-предикатов под RLS в PostgreSQL 17: active orders читались Seq Scan, а strategies — по общему tenant index с фильтрацией. Добавлены SQL-owned `GENERATED ALWAYS ... STORED` признаки `Order.isActive` и `StrategyInstance.isRunning` и соответствующие partial indexes. PostgreSQL пересчитывает их при смене enum-статуса и запрещает подставлять значения. Поля помечены `@ignore` в Prisma: индексированные выборки используют параметризованный SQL с этими boolean predicates. RLS, `enable_seqscan` и системные LEAKPROOF flags не изменялись. Основание: [правила RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) и [обсуждение enum operators в PostgreSQL](https://www.postgresql.org/message-id/CAMxA3rvwEgfbBqRx6UB2TOAmnLp5-SDLmCuhtvKo24i6iY%2Ba2g%40mail.gmail.com). Последующие schema migrations должны сохранять определения generated columns.
