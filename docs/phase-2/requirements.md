# PHASE 2 — требования к базе данных

Дата: **2026-09-06**. Статус: **требования до реализации и проверки PHASE 2**. Основание: разделы 1, 31, 55, 58–61, 72–73, 77–80 и 83 исходного задания; [план этапов](../phase-0/implementation-plan.md), [логическая схема](../database.md), [security model](../security.md) и [ADR-002–007](../adr/README.md). Базовая версия PHASE 1 — `c1b9879`, с успешным CI. Документ определяет приёмку следующего изменения и не утверждает, что перечисленные ниже проверки уже выполнены.

## Объём этапа

Результат PHASE 2 — PostgreSQL schema, version-controlled migrations, необходимые индексы, безопасный development seed и типизированный пакет доступа к БД. Требуются воспроизводимые проверки fresh DB, upgrade и reset отдельной test DB. Prisma и дополнительные SQL migrations используются в пределах возможностей ORM; SQL constraints, RLS, partial indexes и partitioning не заменяются комментариями в Prisma schema.

Схема хранит связи, режимы, версии, ограничения и доказательства будущих операций. Наличие таблиц не означает готовые регистрацию, шифрование credentials, биржевые адаптеры, отправку ордера, риск-проверку, ledger writer, strategy worker, paper execution или backtesting. Соответствующие бизнес-сервисы реализуются в своих фазах. API продолжает предоставлять уже проверенные health endpoints; торговые и auth endpoints в PHASE 2 не добавляются.

## Точный перечень сущностей

Раздел 31 задания содержит **28 обязательных минимальных сущностей**. Принятый database design добавляет **31 вспомогательную сущность**: всего **59 имён в архитектурном перечне**. В PHASE 2 создаются все минимальные модели и вспомогательные записи, необходимые для ownership, mode isolation, версий и durable identity. Для остальных допустима минимальная схема расширения без работающего сервиса. Перенос вспомогательной модели должен быть явно назван в отчёте с целевой фазой и доказательством, что текущие constraints от неё не зависят; молчаливое удаление модели из принятой архитектуры не допускается.

| Область       | Минимальные сущности из задания                                              | Вспомогательные сущности принятого дизайна                            |
| ------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Users/Auth    | User, UserSession, TwoFactorConfig                                           | EmailVerificationToken, PasswordResetToken, RecoveryCode              |
| Connections   | ExchangeConnection, EncryptedCredential                                      | ExchangeAccount, LiveGrant                                            |
| Instruments   | Instrument                                                                   | InstrumentRuleVersion, CapabilitySnapshot                             |
| Accounts      | BalanceSnapshot, Position                                                    | AccountStateVersion                                                   |
| Accounting    | —                                                                            | LedgerTransaction, LedgerEntry, AssetValuation                        |
| Execution     | Order, OrderEvent                                                            | OrderIntent, IdempotencyRecord, AlgoOrder, SubmissionAttempt          |
| Trades        | Trade, Fill                                                                  | Fee, FundingPayment                                                   |
| Strategies    | StrategyDefinition, StrategyInstance, StrategyParameter, StrategyRun, Signal | StrategyState                                                         |
| Risk          | RiskProfile, RiskEvent                                                       | RiskDecision, RiskReservation, RiskBudget, TradingPause, CircuitState |
| Paper         | PaperAccount, PaperOrder, PaperPosition                                      | —                                                                     |
| Backtest      | Backtest, BacktestTrade                                                      | BacktestMetric, DatasetManifest                                       |
| Market        | Candle                                                                       | MarketGap, MarketCheckpoint, SubscriptionAssignment                   |
| Messaging/Ops | Notification, AuditLog, SystemEvent                                          | OutboxEvent, ConsumerInbox, ReconciliationRun                         |

`Trade` группирует жизненный цикл сделки/стратегии, `Fill` обозначает исполнение ордера; публичный market trade tick не подменяет эти записи. `PaperOrder` расширяет общий `Order` через уникальный `orderId` и не хранит конкурирующее состояние ордера. `PaperPosition` связывает позицию с paper account. Backtest хранит результаты внутри своего run и не изменяет PAPER/LIVE balances.

## Ownership, роли и режимы

Tenant в текущей архитектуре соответствует пользователю. Для tenant-owned parent-child связей нужны составные foreign keys, содержащие tenant identity, а не только независимые FK на пользователя и родительский UUID. Подстановка существующего `connectionId`, `orderId`, `strategyId`, `accountId` или другого parent ID пользователя B в запись пользователя A должна отклоняться самой БД.

Account, connection, order, position, fill и paper extensions согласуют account identity и режим составными ключами. Режим по умолчанию — PAPER. LIVE не включается созданием seed или отсутствующим параметром. EXCHANGE_DEMO хранит точный TESTNET/DEMO subtype; PAPER и BACKTEST не могут ссылаться на LIVE destination либо использовать его credentials. Смена режима родителя при существующих несовместимых дочерних записях также отклоняется. Схема LiveGrant хранит привязку к владельцу, connection, environment, credentialVersion и policy version; рабочий dispatch gate появится в PHASE 11–12.

RLS задаётся миграцией с `USING` и `WITH CHECK`. Tenant context устанавливается параметризованно через `SET LOCAL` или эквивалентный transaction-local `set_config` внутри одной SQL-транзакции. Runtime role не является owner, superuser или BYPASSRLS. Отсутствующий/пустой context запрещает tenant data access; malformed context не открывает доступ. Pool reuse после commit, rollback и исключения не переносит контекст A в запрос B. API principal и защита от передачи клиентом чужого tenant ID относятся к PHASE 3; текущий DB helper не является авторизацией HTTP.

Нужна явная таблица grants: migration role управляет DDL; ordinary API runtime работает только с разрешёнными данными; signer/credential privileges отделены; global lookup доступен ordinary runtime только на SELECT. Account-specific capability snapshots остаются tenant-owned, даже если общая instrument metadata публична. Ordinary API role не имеет SELECT/INSERT/UPDATE/DELETE для EncryptedCredential и секретных 2FA-полей. Проверки RLS выполняются реальной непривилегированной ролью, а не владельцем таблиц.

Удаление User/connection/account/order не удаляет каскадом финансовые записи и unresolved evidence. Для таких связей используются RESTRICT/NO ACTION либо эквивалентная явно проверенная политика. Account deletion/pseudonymization workflow будет реализован позже. Audit и финансовые исправления предусматривают добавление записей; обычная runtime role не должна переписывать завершённое историческое evidence.

## Decimal, время и идентификаторы

Internal IDs — UUID; внешние биржевые IDs — непрозрачные bounded strings, включая числовые IDs больше `Number.MAX_SAFE_INTEGER`. Временные отметки — UTC `timestamptz`; порядок history cursor определяется парой timestamp + ID. Счётчики, schema/CAS versions и retry counters — целые числа с допустимым диапазоном и проверками знака.

| Категория         | Допустимый диапазон хранения                        | Примеры                                                                              |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Цена и количество | До 20 целых и 18 дробных цифр, эквивалент `(38,18)` | price, quantity, filled quantity, OHLC, individual asset amount                      |
| Учётные итоги     | До 30 целых и 18 дробных цифр, эквивалент `(48,18)` | Накопленные ledger/balance totals и выделенные accounting aggregates                 |
| Ставки и доли     | До 2 целых и 18 дробных цифр, эквивалент `(20,18)`  | fee/funding rate и risk ratio; дополнительные bounds зависят от поля                 |
| Счётчики          | Integer/BigInt с явно выбранными bounds             | version, attempts, numberOfTrades; contracts имеют отдельный unit и instrument rules |

Это категории schema design, а не подтверждённые лимиты конкретной биржи. Для каждого денежного столбца реализация фиксирует категорию, знак, asset/unit и применимые дополнительные CHECK. Не все денежные поля положительны: PnL, funding, ledger posting и rebate могут иметь разрешённый отрицательный знак. Quantity ордера положительна; накопленное исполнение неотрицательно и не превышает quantity там, где это инвариант одной записи. Новые инструменты за пределами диапазона блокируются до пересмотра схемы.

Over-scale, overflow, NaN и Infinity должны отклоняться без округления, включая **прямую SQL-вставку**. PostgreSQL `numeric(p,s)` может округлить ввод до выполнения CHECK, поэтому для такого контракта применяется numeric без typmod с явными CHECK на finite value, `scale` и диапазон либо другой механизм, доказанно отклоняющий исходное неверное значение. Применение Prisma `@db.Decimal(p,s)` не должно ослаблять этот инвариант. Уточнение физического хранения фиксируется в ADR и migrations.

DB package принимает проверенные decimal strings/Decimal, а не JS `number` для финансовых значений, и сериализует их обратно строками. Перед parsing ограничиваются длина и грамматика, включая exponent abuse. Промежуточная precision Decimal по ADR-005 — минимум 80 значащих цифр; её конкретное применение проверяется содержательными boundary/property tests. Unit не теряется при сохранении: BTC amount и USDT amount не считаются одной величиной.

## Ключи, уникальность и атомарность

Минимальные DB constraints для текущего этапа:

- Idempotency: unique tenant + operation + key, отдельный immutable request hash. Один ключ нельзя незаметно переиспользовать с другим payload. HTTP 409 и работа API idempotency handler относятся к будущему mutation endpoint.
- Signal: unique run + instrument + input identity + rule version + signal kind; повтор входного события не создаёт второй identity.
- Order: unique intent; dispatch attempt: unique order + operation version. CAS version хранится и пригодна для условного UPDATE.
- Client order ID: unique account + environment + namespace + client ID. Ordinary/algo namespace и scope внешнего order ID не смешиваются. Nullable exchange ID получает scoped partial unique constraint, когда ID присвоен.
- Fill: unique account + market + instrument + execution identity; не предполагается глобальная уникальность биржевого execution ID. Foreign keys дополнительно согласуют tenant/order/account/mode.
- ConsumerInbox: unique consumer + event ID. Outbox хранит версию события, доставку, availableAt/attempts и связь с domain evidence.
- Position: unique account + mode + instrument + side + bucket; NET, LONG, SHORT и margin bucket сохраняются отдельно.
- Credential/rule versions: version identity уникальна; не допускаются две current versions одного scope. Версионное historical evidence не перезаписывается обычным UPDATE.
- PaperOrder/PaperPosition: одна extension на родительскую запись и согласованный paper account/mode.
- Candle: unique instrument + timeframe + openTime; выбранные timeframe и OHLC/volume/timestamp constraints не допускают противоречивую запись.

В PHASE 2 проверяются ограничения и механика транзакций: конкурентные INSERT одного intent/fill/inbox identity, условный UPDATE по version, rollback частично выполненной группы записей, повтор migration/seed. Для одного и того же identity одна запись подтверждается, конкурирующая вставка получает ожидаемый constraint conflict; это не обещание exactly-once внешнего эффекта.

Бизнес-транзакции `intent + idempotency + outbox`, `signal + state + cursor + outbox`, `fill + ledger + position + inbox + outbox`, `risk decision + reservation + budget` определены ADR-002, но их прикладные writers вводятся в соответствующих PHASE 10–14. PHASE 2 дополнительно требует deferred SQL enforcement баланса postings по каждому активу и запрета позднего добавления entries в закрытый ledger transaction; прикладной ledger writer и создание correction операций остаются PHASE 10. Существование LedgerEntry само по себе не доказывает сбалансированный ledger. Risk reservation admission, lost exchange response, dispatch/reconciliation и queue relay в текущей фазе не реализуются. SQL transaction не удерживается во время биржевого HTTP/WS.

## Секреты и development seed

EncryptedCredential хранит только ciphertext, nonce, authentication tag, wrapped DEK, key/version и AAD context: owner, connection, exchange, environment, credentialVersion, schemaVersion. Для AES-GCM metadata фиксируются 12-байтовый nonce и 16-байтовый tag; plaintext API key/secret/passphrase/DEK не имеют столбцов. 2FA secret также хранится в encrypted representation. Session/reset/verification/recovery tokens представлены hash, expiry, revoked/consumed state. Создание действующих токенов, Argon2 hashing и encryption/enrollment services будут реализованы в PHASE 3 и credential boundary.

Seed допускается только при явном development/test окружении и проверенной цели БД. Production/staging, неявное окружение и чужая БД приводят к отказу до записи. Seed не вызывает биржи, не создаёт LIVE grants, не подключает реальные accounts, не содержит реальных credentials, фиксированного пароля администратора или plaintext tokens. Пользовательские fixture accounts не становятся действующими login без будущей auth-реализации.

Development fixtures имеют явное происхождение и стабильную identity. Synthetic instrument/rules не выдаются за актуальную биржевую metadata: они помечены как fixtures и не допускают реальную торговлю. Предпочтительный набор — отключённый development user, PAPER account и минимальные lookup/fixture записи, необходимые для просмотра структуры; исполняемые стратегии и наполненный фиктивный торговый портфель не требуются.

Повторный seed сохраняет количество и identity управляемых записей, не уничтожает пользовательские данные и не сбрасывает изменённые balances/settings. Concurrent seed использует DB uniqueness и транзакцию; read-before-insert без constraint недостаточен. Seed log показывает только безопасные счётчики/идентификаторы, без DSN, password, token, ciphertext или raw database exceptions.

## Migrations, partitioning и query plans

Все изменения schema поставляются migrations с фиксированной историей. Production `schema push` и автоматическое destructive reset отсутствуют. Генерация Prisma Client воспроизводима; SQL-only constraints/RLS/indexes не пропадают при следующем изменении Prisma schema. Для будущих migrations документируются expand/contract и forward-fix; destructive downgrade не объявляется безопасным rollback без отдельного доказательства.

Upgrade проверяется на предшествующей **реальной версии schema с данными**, затем применяется следующая миграция и сверяются identity/значения/связи. Повтор применения одной финальной схемы не подменяет этот сценарий. На fresh DB применяется вся история; повтор команды migration не создаёт повторных объектов. Ошибка migration не считается успехом; после устранения причины проверяется восстановимый путь продолжения.

Reset разрешён только runner-созданной disposable test DB с проверенными именем/marker/project identity. Тестовая конфигурация не заимствует пользовательский DATABASE_URL и не удаляет development/production volumes. После reset вся migration history и тестовые fixtures воспроизводятся заново. Отдельно проверяется отказ reset при несовпадающей цели.

Индексы соответствуют запросам, а не каждой колонке: Order history по tenant + createdAt + ID; active orders по tenant/account/status/instrument; Fill по tenant/order/time и tenant/instrument/time; StrategyInstance по tenant/status; Candle range по instrument/timeframe/openTime; undelivered outbox по availableAt; unresolved submission/reconciliation; audit/backtest/notification history по tenant/time/ID.

Принятый дизайн предусматривает UTC time partitions для Candle, с openTime в unique key. Финансовые dedup/identity tables первоначально не партиционируются. Физические partitions и границы их диапазонов задаются проверяемым SQL; отсутствующая подходящая partition не должна молча терять данные. Retention/partition maintenance worker и archive delivery относятся к market-data/production фазам. Raw ticks не добавляются в бесконечную OLTP-таблицу; unresolved orders, reservations, inbox до replay horizon и финансовое evidence не удаляются обычным TTL.

`EXPLAIN (ANALYZE, BUFFERS)` выполняется для representative fixtures с записанными числом строк и селективностью. Проверяются запросы history, active orders, fills, strategies, candles и ready outbox; для partitions — pruning. Не нужно отключать seqscan ради искусственного PASS: выбор последовательного чтения маленькой таблицы допустим, решение объясняется фактическим планом. Keyset pagination проверяется на одинаковых timestamps и concurrent inserts без дублей/пропуска уже существующих записей; HTTP signing/filter validation cursor остаётся будущему API.

## Интерфейсы и сценарии приёмки

Контракты нового database package: создание клиента с явной конфигурацией и ограниченным pool; транзакция с обязательным tenant context; безопасное преобразование decimal; idempotent close. CLI отдельно предоставляет client generation, migration deployment и development seed. Migration credentials не становятся default runtime credentials. Точные команды и выходные коды документируются после реализации.

| Проверка            | Сценарии и ожидаемый результат                                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema completeness | Все 28 обязательных моделей существуют; вспомогательные модели/переносы сверены с перечнем; generated imports работают после clean build                                          |
| Fresh migrations    | Пустая изолированная БД → вся migration history → schema/constraints/indexes/RLS соответствуют ожидаемым                                                                          |
| Upgrade             | Предыдущая migration version + данные → upgrade без потери данных → повтор deploy без повторного эффекта                                                                          |
| Safe reset          | Disposable target сбрасывается и восстанавливается; неизвестный project/marker, development/production target отклоняются до удаления                                             |
| Ownership           | A не читает/меняет/удаляет B; forged composite parent FK отклоняется; missing/invalid tenant context fail closed; pool context не протекает после commit/rollback                 |
| Grants              | Тесты идут non-owner runtime role; DDL/TRUNCATE/credential access запрещены; global lookup SELECT разрешён, его mutation запрещён                                                 |
| Modes               | PAPER default; несовместимые account/environment/mode и ложная paper extension отклоняются самой БД                                                                               |
| Decimal             | Точная round-trip строка, границы каждой категории, один лишний разряд/scale, NaN/Infinity, malformed/exponent/oversized input; raw SQL не округляет запрещённый ввод             |
| Constraints         | Orphans, отрицательные forbidden amounts, несовместимые стороны/статусы/время, повтор current version и неверный scoped external identity отклоняются                             |
| Concurrency         | Две реальные транзакции с одним intent/fill/inbox identity дают один durable identity; два CAS UPDATE одной версии дают одного победителя; rollback не оставляет частичный эффект |
| Seed                | Первый, повторный и конкурентный запуск; стабильные управляемые IDs/counts; пользовательские изменения сохранены; production target и unsafe credentials отклоняются              |
| Query plans         | Representative EXPLAIN ANALYZE/BUFFERS, нужные индексы/pruning, устойчивый timestamp+ID cursor при concurrent inserts                                                             |
| Logs/runtime        | Ошибки миграции/constraint/connection/seed не раскрывают secrets; client/pool закрываются; нет unhandled rejection; phase1 health/lifecycle не регрессируют                       |

Этап закрывается только после успешных formatter, lint, strict typecheck, содержательных unit и настоящих PostgreSQL integration tests, clean build, применимых runtime/Docker проверок и обязательного CI. Проверки используют отдельные роли/namespace/данные, не отрабатывают destructive сценарии на пользовательской БД. Отчёт перечисляет реальные команды, exit codes, исправленные ошибки, точные файлы и ограничения. Failed/skipped/missing environment не превращаются в PASS. Полный auth, торговля, работа ledger/risk writers и production readiness не заявляются на основании одной готовой schema.
