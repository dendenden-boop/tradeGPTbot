# Deployment и восстановление — проект PHASE 0

Дата: **2026-09-05**. Это проект эксплуатации [архитектуры](architecture.md). Инфраструктура не развёрнута; benchmark, migrations, restore drill и security tests ещё не выполнялись. Провайдер и бюджет не выбраны.

## Процессы и инфраструктура

Modular monolith развёртывается отдельными процессами: web/API/realtime, market ingest, strategy, execution/private connector, background/outbox/reconciliation, backtest. Один versioned domain contract; независимые CPU/memory/concurrency budgets. Backtest не разделяет event loop и resource limit с execution. Сначала Docker Compose для разработки; production — управляемый orchestrator с workload identity, без требования Kubernetes как обязательного компонента.

TLS завершается на reverse proxy; private hops, PostgreSQL/Redis/KMS используют проверяемые защищённые соединения. БД и Redis недоступны из интернета. Signer имеет отдельные IAM, endpoint egress allowlist и стабильные egress IP для бирж. Secret manager хранит runtime secrets, KMS — KEK; repository, image, `.env.example` и CI artifacts содержат только placeholders. Раздельные среды, ключи, очереди, DB credentials и DNS; production credentials не монтируются в development.

PostgreSQL хранит ledger, intent, submission attempt, inbox, reservations и outbox. Outbox создаётся в финансовой транзакции; relay повторяем, delivery at-least-once. BullMQ jobId помогает маршрутизации, но не доказывает отсутствие повторного финансового эффекта. После потери Redis задания восстанавливаются из durable state; dispatch требует DB claim/CAS и проверки попытки отправки.

Для BullMQ — отдельный Redis instance с persistence и `maxmemory-policy=noeviction`; market cache — другой instance с собственной eviction policy. Разные Redis logical databases не изолируют память/eviction. При переполнении queue Redis новые записи могут отказать: alarm, backpressure и остановка новых dispatch; outbox остаётся в PostgreSQL. BullMQ прямо требует noeviction и предупреждает, что job data хранится открыто. [Production guidance](https://docs.bullmq.io/guide/going-to-production)

Начальные budgets — гипотезы: CPU backtest ≤25% пула, DB connections с резервом 20% для reconciliation/control, queue memory alert 70%/85%, bounded payload/page sizes. Общие rate buckets учитывают exchange UID и egress IP; отдельный резерв cancel/reconciliation не обходит биржевой лимит. Capacity подтверждать профилями 300/600/1200 инструментов и реальным числом private accounts.

## Доставка и наблюдаемость

CI: pinned runtime/lockfile, lint/typecheck/unit/integration, dependency advisories, secret scan, SBOM, immutable image digest. Promotion одного проверенного image между средами. Production deploy требует совместимых schema/events; миграции выполняет отдельная временная роль.

Expand-contract: добавить совместимые поля/таблицы → обновить readers/writers → bounded resumable backfill → проверить invariant/counts → переключить чтение → удалить старую схему отдельным релизом. Старые queued events читаются по schemaVersion. Destructive migration требует backup и репетиции; rollback бинарника разрешён только при совместимой схеме. Откат БД не отменяет сделок биржи.

JSON logs содержат request/intent/attempt/correlation IDs; финансовые audit records отделены от diagnostic logs. Prometheus: event-loop lag, WS freshness/gaps, outbox age, queue lag, UNKNOWN age, reconciliation drift, limiter rejects, KMS errors, DB lag, risk blocks. OTel связывает signal→dispatch→fill без secret payloads. Ограничить label cardinality: tenant/order IDs — в разрешённых логах/traces, не labels метрик.

Liveness проверяет жизнеспособность процесса; readiness — его зависимости и способность обслужить роль; trading-readiness — отдельный fail-closed gate. External exchange outage не должен бесконечно перезапускать здоровый процесс. Graceful shutdown: снять readiness, прекратить claims/новые dispatch, зафиксировать outcomes/UNKNOWN, завершить ограниченный drain, сбросить cursors/outbox, закрыть WS/пулы. Истёкший shutdown timeout оставляет recoverable durable state; новый worker не пересылает попытку автоматически. [BullMQ shutdown](https://docs.bullmq.io/guide/going-to-production#gracefully-shut-down-workers)

## Backup, RPO/RTO и runbook

Предлагаемые цели, **не SLA**: PostgreSQL disaster RPO ≤5 минут; RTO read-only/reconciliation ≤60 минут. LIVE RTO не фиксируется до устранения неоднозначных external effects. PITR требует base backup и непрерывного WAL archive. [PostgreSQL PITR](https://www.postgresql.org/docs/current/continuous-archiving.html)

Проект retention: ежедневный encrypted base backup, WAL 14 дней, ежедневные backups 30 дней, месячные 90 дней; immutable bucket в отдельном failure domain. Audit/ledger retention определяется отдельно; unresolved intents/evidence не удаляются TTL. Нужны inventory KEK versions, restore permissions и резерв конфигурации/IaC без plaintext secrets. Архивирование проверяется по lag и тестовой расшифровке, а не наличию файла.

1. При аварии заблокировать LIVE внешним deployment gate, остановить старых dispatchers, сменить lease epoch; сохранить evidence и определить recovery point.
2. Восстановить isolated PostgreSQL, проверить WAL continuity, constraints/ledger, KMS decrypt и версии приложения. Не восстанавливать старый LIVE grant как разрешение торговли.
3. Пересоздать queues из outbox и незавершённых intents; старые отправки считать потенциально исполненными. Сверить exchange orders/history/fills/positions с момента раньше recovery point. Недоступные данные означают RECONCILIATION_REQUIRED.
4. Оператор документирует расхождения и корректировки через auditable command; запретить «retry all», ручное удаление UNKNOWN и прямую правку balances. Cancel/reduce проходят собственные проверки.
5. Возобновить read-only/PAPER; LIVE rearm выполняется отдельно после reconciliation, freshness, permissions и step-up владельца, с новым grant/epoch. Автоматический restart сервиса не включает LIVE.

Restore drill — ежемесячно и перед существенными migration/KMS изменениями: потеря Redis, PITR после отправленного ордера, повтор outbox, недоступный KEK, поздний старый worker. Приёмка: измеренные RPO/RTO, отсутствие повторного dispatch, полный audit и неизменный запрет LIVE до явного rearm. Все эти проверки запланированы на последующие фазы.
