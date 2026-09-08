# Architecture Decision Records — PHASE 0

Дата: **2026-09-05**. Статус ADR-001–007: **принято как проектное решение PHASE 0; не реализовано и не проверено runtime-тестами**. Основание: [архитектура](../architecture.md) и [требования и противоречия](../phase-0/requirements.md). Изменение решения оформляется новым ADR со ссылкой на заменённый; история причин сохраняется.

## ADR-001 — Modular monolith с отдельными worker-процессами

**Context.** Команда должна последовательно реализовать 22 этапа, сохранив возможность масштабировать market data, execution и backtests независимо. Начальное разбиение на множество сервисов усложнило бы транзакции и восстановление раньше появления измеренной нагрузки.

**Decision.** Один TypeScript strict monorepo на pnpm workspaces: Fastify API, Next.js web, отдельные точки запуска market-data, strategy, execution и background workers. Domain и application services не зависят от HTTP и конкретной биржи. Модули владеют своими данными; межмодульные записи идут через application contracts. Backtests и тяжёлые расчёты получают отдельный ограниченный CPU pool. PHASE 1 закрепляет версии, import boundaries и единые проверки.

**Alternatives.** Микросервисы с первого дня; один процесс для API и всей торговли; NestJS с Fastify adapter. Первый вариант увеличивает распределённую сложность, второй объединяет отказ и event-loop contention, третий допустим технически, но дополнительный framework сейчас не нужен.

**Consequences.** Общий release graph и БД требуют дисциплины миграций. Изоляция процессов уже позволяет отдельно ограничить ресурсы и права execution. Монорепозиторий сам по себе не гарантирует модульность.

**Revisit.** Измеренное насыщение отдельных workers, необходимость независимых команд/релизов либо нарушение согласованных SLO после локального масштабирования.

## ADR-002 — PostgreSQL хранит торговую истину, очередь доставляет задания

**Context.** Публикация события независимо от commit теряет задания или создаёт действия без соответствующей записи. Redis outage не должен стирать финансовое состояние.

**Decision.** PostgreSQL хранит intents, orders, fills, ledger, reservations и audit evidence. Изменение domain state и outbox фиксируются одной транзакцией. Relay передаёт задания BullMQ с семантикой at-least-once. Consumer фиксирует inbox/dedup key вместе с финансовым эффектом; ACK следует после commit. Уникальные constraints и CAS/version checks обязательны. Queue job содержит идентификатор и версию, а consumer перечитывает authoritative state. Восстановление очереди возможно из outbox; unresolved операции не удаляются по обычному TTL.

**Alternatives.** Redis как финансовая БД; dual-write DB+queue; Kafka как обязательная инфраструктура с первого этапа; полагаться на queue uniqueness. Эти варианты не устраняют границу DB/exchange и добавляют неподтверждённые предпосылки.

**Consequences.** Нужны relay leases, retry/DLQ policy, backlog monitoring, индексы и retention. Повтор задания нормален; повтор ledger effect — нарушение инварианта. Недоступность БД блокирует новый dispatch, даже если очередь доступна.

**Revisit.** Измеренная пропускная способность или retention outbox превышают бюджет PostgreSQL; замена транспорта сохраняет transactional outbox/inbox и семантику доставки.

## ADR-003 — Единственная отправка intent и явная неопределённость

**Context.** Между локальной записью и принятием ордера биржей нет общей транзакции. Ответ может потеряться после fill. Истечение lease не доказывает, что старый worker перестал выполнять сетевое действие.

**Decision.** До отправки атомарно фиксировать durable submission attempt, destination, immutable payload/hash и client ID; CAS допускает единственного владельца dispatch этого intent. Автоматические transport/SDK retries торговых мутаций запрещены. Повтор задания уже начатой попытки выполняет reconciliation, не повторный POST. Crash до/после send, timeout и неоднозначный ответ переводят попытку в UNKNOWN и соответствующий scope в RECONCILIATION_REQUIRED. Полученный fill имеет приоритет над предположением о неудаче. Новые действия после подтверждённого отказа оформляются новой явно связанной попыткой/intent по политике и снова проходят risk.

Lease и fencing epoch защищают локальные записи, **но не ограждают внешний API биржи**. После потери lease новая replica не отправляет тот же intent; поздний ответ старой принимается как evidence для reconciliation. Перед takeover нельзя считать старый процесс остановленным без подтверждения остановки либо снятия его возможности внешнего dispatch. Уже отправленный сетевой запрос остаётся in-flight независимо от kill switch. Exactly-once внешний эффект не обещается.

**Alternatives.** Повтор с тем же client ID; распределённый lock как единственная защита; автоматический resend после отсутствия ордера в одном snapshot. Client ID имеет exchange-specific срок/область уникальности, а snapshot может запаздывать.

**Consequences.** Предпочитается временно пропущенная сделка возможному дублю. UNKNOWN может потребовать ручного расследования; отсутствие записи не всегда разрешает новый риск. Нужны crash/lost-response/late-worker tests и сохранённая трасса решения.

**Revisit.** Биржа документирует более сильный idempotency contract и он подтверждён contract tests; либо появляется проверяемое внешнее fencing. Простая смена очереди основанием не является.

## ADR-004 — Возможности адаптера привязаны к среде и аккаунту

**Context.** Название биржи не определяет доступные рынки, параметры ордера, demo и hedge. Native algo orders могут иметь собственные IDs, состояния и события.

**Decision.** Capability profile версионируется по exchange, region, environment, account/accountMode, market и instrument. Значения: supported, unsupported, unverified; последнее блокирует соответствующее торговое действие. PAPER использует отдельный ledger и simulator; EXCHANGE_DEMO хранит точный TESTNET/DEMO subtype и endpoints; LIVE отдельный destination. Начальный mutation transport — REST, private WS доставляет события, REST queries восстанавливают состояние. Trading WS может добавляться отдельной capability после проверки бюджетов и recovery. Native ordinary, algo/conditional и order-list lifecycle моделируются раздельно; synthetic stop требует отдельного согласованного дизайна, не маскируется под native.

**Alternatives.** Один boolean на биржу; универсальный `createOrder(type, amount)` без units/account scope; SDK автоматически выбирает транспорт/окружение.

**Consequences.** Больше явных discriminated unions и fixtures, зато невозможна незаметная подмена среды или семантики. Изменение instrument rules инвалидирует старую validation/risk оценку. Private events не являются гарантированным replay log.

**Revisit.** Новые account models, рынки, API migration или подтверждённая необходимость WS trading; каждое расширение получает свой acceptance gate. Официальные факты: [исследования бирж](../exchange-adapters.md).

## ADR-005 — Decimal и размерные денежные типы

**Context.** Base quantity, quote spend и contracts не взаимозаменяемы. Двоичный float и округление по количеству decimal places могут нарушить lot/tick/notional и исказить баланс.

**Decision.** Decimal.js для будущих денежных вычислений, проверенные decimal strings на API/queue границах; явные типы Price, BaseQuantity, QuoteAmount, ContractQuantity и Rate с asset/instrument context. Уточнение PHASE 2: PostgreSQL хранит `numeric` без typmod с явными CHECK для каждого поля, поскольку `numeric(p,s)` округляет лишние дробные цифры до проверки. SQL и приложение отклоняют overflow/over-scale; диапазоны price/quantity/amount — 20 целых и 18 дробных цифр, aggregate — 30 и 18, rate — 2 и 18. Один универсальный диапазон не предполагается. Рабочая precision расчётных writers включает промежуточные произведения/деления; rounding mode и момент quantization документируются по операции. Tick/step применяются как кратность, после quantization повторно проверяются notional и риск. [Поведение NUMERIC в PostgreSQL 17](https://www.postgresql.org/docs/17/datatype-numeric.html).

**Alternatives.** JavaScript number; хранить всё целыми satoshi; универсальный `numeric` без ограничений. Первый вариант неточен, второй требует разных масштабов и unit rules, третий переносит отказ на память/БД.

**Consequences.** Больше явных преобразований; malformed, exponent abuse и слишком длинные числа отклоняются до Decimal parsing. Результаты fees/funding и inverse instruments требуют собственных формул и property tests. IDs хранятся непрозрачными строками, не денежными Decimal.

**Revisit.** Инструмент не помещается в принятый диапазон либо измеренная стоимость вычислений нарушает SLO; изменение precision требует миграции и повторной проверки финансовых инвариантов.

## ADR-006 — Общий market-data ingest и очереди с политикой по типу события

**Context.** Подписка на каждую пару для каждого пользователя умножает нагрузку. Неограниченный buffer лишь откладывает отказ; потерянные trades нельзя объявлять полноценными свечами.

**Decision.** Публичный ingest разделяется всеми tenants по exchange/environment/market/instrument; private streams изолированы по счёту. Partition ownership и epochs, ограниченные queues и budgets входят в контракт. Для ticker/latest quote допустимо coalescing; для trades/candle input переполнение создаёт явный gap и backfill/rebuild. Для financial events overflow ведёт к resync/reconciliation и блокировке нового риска, не к незаметному drop. OHLC 30s агрегируются из достаточных granular events по event time; minute OHLC не делятся на две придуманные свечи. Свеча хранит quality/version, late-event policy и provenance. Неполная история ограничивает стратегии и backtests.

**Alternatives.** Per-user public subscriptions; unlimited queues; одинаковая lossy policy для ticker и fills; обещание отсутствия потерь при бесконечном outage.

**Consequences.** Reconnect и replay требуют dedup, sequence handling, snapshot reconciliation и fair scheduling. WS capacity считается по streams и event rate, не только symbols. 300/600/1200 инструментов — будущие load profiles, не подтверждённая производительность.

**Revisit.** Измерения event bursts, качества backfill и soak показывают необходимость иного partitioning или более долговечного журнала granular data.

## ADR-007 — Tenant isolation, изолированная подпись и PAPER по умолчанию

**Context.** Компрометация Web/API не должна автоматически открывать все биржевые credentials. Шифрование at rest не предотвращает утечку из привилегированного процесса. LIVE нельзя запускать до завершения risk/execution gates.

**Decision.** Envelope encryption с KMS/secret manager и workload identity; ciphertext в БД, plaintext кратковременно только в private connector/signer. UI, jobs, traces и audit не содержат secrets. Signer ограничен allowlist операций и endpoints; проверяет account/environment, hash разрешённого payload и актуальный dispatch gate. Generic sign arbitrary request API отсутствует; withdrawal operations отсутствуют. Ownership обязателен в HTTP, WS, jobs и DB keys; RLS — дополнительный слой, не замена авторизации. Администратор не получает штатного доступа к расшифровке ключей.

PAPER установлен по умолчанию. LIVE требует явного серверного действия пользователя и готовности PHASE 11–12/security gates, проверенных permissions, account state и capabilities. UNKNOWN закрывает увеличение риска. Изменение leverage/hedge или migration среды не происходит автоматически. Risk reduction также проходит отдельные проверки, чтобы close не открыл противоположную позицию.

**Alternatives.** Общий master key в web env; decrypt credentials в API; tenantId только из запроса; frontend-only LIVE toggle; автоматическое включение LIVE после успешного demo.

**Consequences.** Нужны rotation/revoke, audit административных действий и cross-tenant negative tests. В JS нельзя обещать гарантированное zeroization памяти; runtime compromise signer остаётся угрозой и ограничивается privileges/egress/изоляцией. KMS или permission uncertainty блокирует LIVE dispatch.

**Revisit.** Выбор deployment-провайдера, требования tenancy/комплаенса либо подтверждённые ограничения KMS/signature algorithms; ослабление LIVE gate не допускается ради удобства.
