# PHASE 3 Hardening — требования

Основание: отдельное пользовательское задание на независимый аудит PHASE 3 перед PHASE 4. Исходный commit: `fac5c07065dc9980a970a28e30a9c9530ce1b09b`; исходная рабочая папка чистая. Проверяем текущий код и воспроизводимые свойства, а не принимаем прежние verification-документы за доказательство.

Повторный review начат 28 сентября 2026 с опубликованного `63c96ac43324b12fbd4e30fdab12035b667a08ff`, при чистой рабочей папке. Это продолжение проверки PHASE 3, включая согласованность PostgreSQL readiness, SMTP capacity и account-enumeration contract. Предыдущие PASS и gate сохраняются как история проверенного commit; новые изменения требуют собственной проверки и не наследуют этот результат.

## Границы

Только authentication foundation, его HTTP, PostgreSQL, Redis, SMTP, конфигурация, deployment и тестовые инструменты. Реализация Exchange Core и адаптеров бирж исключена. В первоначальном аудите migrations 001–004 сохранялись неизменными, а изменения БД оформлялись migration 005. К началу повторного review опубликованы уже 001–005: все пять файлов неизменяемы; текущие исправления readiness и SMTP не требуют новой SQL migration. Данные и секреты пользователей не используются: проверки работают с изолированными disposable services и случайными canaries.

## Дополнительные требования повторного review

- PostgreSQL readiness должна отвергать прямое и транзитивное членство runtime/auth/function-owner в предопределённых ролях PostgreSQL с доступом вне разрешённого auth contract. Проверка только флагов `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB` и `REPLICATION` недостаточна. Безопасная пользовательская grouping role допустима только для runtime/auth LOGIN при сохранении остальных проверок effective privileges; function-owner по-прежнему не может наследовать никакую роль.
- Единственный SMTP readiness probe не должен отнимать один из восьми delivery slots. Проверяются оба порядка запуска: probe до deliveries и deliveries до probe, overflow и shutdown при сохранении общего bounded limit.
- Удержание mail reservation не должно зависеть от eligibility адреса, подавления выдачи token или результата SMTP send. При одинаковой загрузке eligible и unknown requests должны давать одинаковый admission следующего запроса; generic responses и timing samples сами по себе этого не доказывают. Capacity, recovery и shutdown проверяются отдельно, а ограничение throughput фиксируется явно.
- Текущий operating limit — восемь email operations за пять секунд на процесс плюс lookup/work, включая generic no-op ветви. Enumeration pacing не входит в measured request latency; samples первой выдачи token и no-op внутри 60-second cooldown маркируются как смешанные, без утверждения о constant time.
- Результаты новых negative tests до исправления, проверки после исправления и CI публикуются раздельно. До полного validation новых изменений текущий gate остаётся **NOT READY FOR PHASE 4**.

## Проверяемые свойства

| Область           | Обязательное доказательство                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline          | SHA, git status, реальные exit status всех исходных команд, число тестов; отдельное объяснение каждого исходного сбоя                                                      |
| Redis cardinality | Реальный Redis: один IP, исчерпанные coarse limits, новые identities, несколько endpoints, влияние на другого клиента и существующие keys, TTL и ограничения памяти        |
| Proxy/IP          | Реальные сетевые fixtures: direct spoof, trusted/untrusted proxy, несколько hops, malformed/duplicate XFF; явная production trust policy                                   |
| Сессии            | До/после: 10/50/100 concurrent authenticate одного пользователя; lock waits, UPDATE, приблизительный WAL; безопасность touch и state transitions                           |
| SMTP              | Boot при недоступной почте, core readiness, verified login, authenticated reads/logout, controlled 503 для email operations, восстановление без restart                    |
| Recovery          | Повторный запрос постороннего не ломает ранее отправленную ссылку; bounded tokens, cooldown, TTL; конкурентное одноразовое consume                                         |
| Retry-After       | Реальное оставшееся время блокирующих buckets, в том числе нескольких одновременно; целые секунды HTTP                                                                     |
| Cookie UX         | Malformed/revoked cookie допускает безопасное восстановление preauth/CSRF/login без доверия cookie                                                                         |
| Request ID        | Поиск всех usages; повторяемый клиентский correlation ID не является principal, idempotency key или уникальным audit event                                                 |
| Retention         | Сроки и безопасный порядок очистки expired/consumed tokens и sessions; evidence отдельно; отсутствие скрытого unlimited storage claim                                      |
| DB security       | Повторный negative audit ctp_api/ctp_auth/ctp_auth_owner, column grants, RLS FORCE, ownership, PUBLIC EXECUTE, search_path, temp hijacking                                 |
| Concurrency       | Login против reset/logout-all/MFA; двойная rotation/reset/verification; смена пароля; чужая revoke; stale snapshot                                                         |
| Enumeration       | Unknown/active/pending/suspended/MFA: status, body/length, Argon work, SMTP и Redis paths, timing sample без обещания network constant time                                |
| Argon2            | Не снижать work factor; две активные операции, bounded queue, overflow, dummy verification, malformed PHC, shutdown, память и event-loop responsiveness                    |
| Email             | Согласованная ASCII product grammar: Node normalization, PostgreSQL и SMTP; deterministic boundary/fuzz corpus                                                             |
| Cookies/CSRF      | Secure/HttpOnly/SameSite, host-only/Path, ротация binding, duplicate headers/cookies, fixation, чужая/своя прежняя сессия, signed preauth                                  |
| Targeted load     | 100 пользователей/сессий; mixed login/me/rotation; отдельный burst 50 запросов одного пользователя; attack, SMTP outage, Redis latency; percentiles, queues, locks, errors |

## Инварианты

Raw session tokens не возвращаются в JSON и не логируются. Пароли, email, SQL, DSN и backend errors не попадают в security responses/logs. Reset/change password сохраняют sessionEpoch, отзыв sessions и LIVE grants. ADMIN/MFA не получают password-only вход. Tenant определяется серверным principal. Runtime не получает BYPASSRLS; функции SECURITY DEFINER сохраняют безопасный фиксированный search_path и узкие grants.

## Проверки и gate

До изменений запускаются `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:http`, `pnpm test:database`, `pnpm test:runtime`, `pnpm test:integration`, `pnpm test:smoke`, `pnpm test:clean`, `pnpm docs:check`, `pnpm audit --json`. Сборка нужна перед compiled runtime/deploy checks.

После изменений: `pnpm format`, все перечисленные проверки, специализированные auth-hardening tests и `pnpm benchmark:auth`. PASS означает реальный успешный запуск; неисполненные и падающие проверки отмечаются отдельно. Новые дефекты подтверждаются воспроизведением или техническим доказательством до исправления. Итоговые findings содержат ID, severity, status, affected code, reproduction, impact, root cause, fix, regression test и residual risk.

Gate PHASE 4 закрыт до устранения P1, подтверждённой безопасной proxy/IP модели, закрытия cardinality DoS одним IP, SMTP failure isolation, измерения session contention, concurrency/role regression checks и полного validation. Готовность к следующему этапу не означает готовность к production trading.
