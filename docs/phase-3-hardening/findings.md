# PHASE 3 Hardening — findings

Аудит начат с `fac5c07065dc9980a970a28e30a9c9530ce1b09b`. Первоначальный список рисков проверен по коду и отдельным воспроизведениям. Ниже различаются исправление в исходниках и завершённая проверка исправления. Integration после migration 005 и финальные локальные проверки кода завершились PASS; clean deploy также PASS; Docker smoke также PASS в [CI 36392668471](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/36392668471) для commit `20f25872394c9d71fefa98edffe2aa5b50a316d5`. Подтверждённые локальные host failures сохранены в истории; итог — **READY FOR PHASE 4**. Текущий gate и артефакты — в [verification](verification.md), область задачи — в [requirements](requirements.md).

| ID     | Severity | Finding                                                                | Reproduced                                     | Status                                          |
| ------ | -------- | ---------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| H3-001 | P1       | Запрещённые запросы одного IP исчерпывают общий Redis index            | Да, настоящий Redis                            | Исправлено; 26 Redis tests PASS                 |
| H3-002 | P1       | Reverse proxy объединяет client IP и auth budgets                      | Да, реальные HTTP sockets                      | Исправлено; HTTP regression PASS                |
| H3-003 | P2       | Каждый authenticate блокирует User и обновляет session                 | Да, реальный benchmark 004→005                 | Before/after и полный DB runner PASS            |
| H3-004 | P2       | SMTP outage блокирует запуск core API                                  | Да, composition и Compose review               | Исправлено; application и Docker smoke PASS     |
| H3-005 | P2       | Неаутентифицированный resend уничтожает действующую ссылку             | Да, реальный 004→005 fixture                   | Before/after и полный DB runner PASS            |
| H3-006 | P3       | Retry-After не соответствует blocking bucket                           | Да, константа в handler; Redis TTL regressions | Исправлено; Redis/HTTP PASS                     |
| H3-007 | P2       | Malformed session cookie блокирует новый login flow                    | Да, baseline GET csrf → 401                    | Исправлено; HTTP regression PASS                |
| H3-008 | P2       | Historical transaction snapshot сохраняет устаревшее MFA state         | Да, реальный 004→005 fixture                   | Before/after и полный DB runner PASS            |
| H3-009 | P2       | Readiness недостаточно проверяет effective column grants               | Технически подтверждено                        | Исправлено; negative SQL tests PASS             |
| H3-010 | P3       | SQL допускает адреса вне product email grammar                         | Да, 004 принимает три divergent cases          | Before/after, Node/SMTP и полный DB runner PASS |
| H3-011 | P2       | Early rejection composite probe освобождает single-flight слишком рано | Да, sibling вызван дважды                      | Исправлено; unit и runtime PASS                 |
| H3-012 | P3       | Клиент может повторить request ID                                      | Да; security defect не подтверждён             | Diagnostic-only semantics зафиксированы         |
| H3-013 | P3       | Revoked cookie / tampered preauth требуют ручного удаления             | Не подтверждено                                | Независимый HTTP test PASS до изменений         |
| H3-014 | P3       | Нет автоматического удаления старых auth records                       | Технически подтверждено                        | Обязательная production task; policy ниже       |

## H3-001 — cardinality exhaustion

- **ID:** H3-001.
- **Severity:** P1.
- **Status:** исправлено; dedicated real-Redis suite завершился PASS.
- **Affected code:** [rate-limit.ts](../../packages/auth/src/rate-limit.ts), [service.ts](../../packages/auth/src/service.ts).
- **Reproduction:** baseline `test-results/auth-limiter-hardening-before.json`: 10 020 запросов с новыми identities, один IP/один endpoint, только 20 admitted. Созданы 9997 identity keys, общий index достиг 10 000; новый другой IP denied, уже существующий допустимый key продолжил работать. При трёх endpoints admitted 60, созданы 9995 identities и получен тот же отказ другому IP. Первое исчерпание index требует соответственно 9997/9995 новых identities, а не исчерпания всех их индивидуальных budgets.
- **Impact:** локальный abuse прекращает admission новых auth clients всей платформы; правильные password/CSRF не защищают от отказа общей capacity.
- **Root cause:** Lua создавал все dimensions даже после отказа coarse IP bucket, а все keys делили один hard limit.
- **Fix:** обязательный порядок `ip → operation → identity`; отказ coarse dimension не создаёт новые последующие keys. Уже существующие counters учитываются без продления окна. Вместо общего index — 3 scopes × 16 shards × 512 slots: максимум 24 576 новых indexed counters/48 indexes. HMAC-derived keys не дают клиенту выбрать shard. Сохраняются имена counters и оставшиеся budgets при rollout; legacy index истекает сам.
- **Regression test:** [rate-limit-hardening.integration.test.ts](../../packages/auth/test/rate-limit-hardening.integration.test.ts) — один/три endpoints, 10 020 attempts, cross-IP, существующий key, coarse denial, shared identity limit, TTL, shard saturation/recovery, legacy counters. После исправления созданы только 20/60 identities; другой IP admitted; denied identity не создана. Совместно с [обычными Redis tests](../../packages/auth/test/rate-limit.integration.test.ts) — 26 PASS.
- **Residual risk:** распределённый abuse всё ещё может исчерпать отдельный shard; admission там fail closed до освобождения slot. Capacity требует production measurement/alarms; bounded state не означает бесконечную доступность при DDoS. Во время rollout старые counters могут временно существовать до своих исходных TTL.

## H3-002 — reverse proxy и client IP

- **ID:** H3-002.
- **Severity:** P1.
- **Status:** исправлено; real-socket HTTP regressions PASS.
- **Affected code:** [app.ts](../../apps/api/src/app.ts), [client-ip.ts](../../apps/api/src/client-ip.ts), [config](../../packages/config/src/index.ts), все auth route contexts.
- **Reproduction:** неизменённый compiled API за локальным reverse proxy получил XFF `198.51.100.1` и `198.51.100.2`; оба HTTP 200 передали limiter `127.0.0.1`. Новый тест до исправления получил тот же результат. Baseline использовал `trustProxy: false`.
- **Impact:** login/signup/forgot-password/CSRF одного клиента расходуют budgets остальных клиентов того же proxy; brute-force control теряет необходимую адресную granularity.
- **Root cause:** deployment предполагает proxy, но API использовал только socket peer.
- **Fix:** `TRUSTED_PROXY_CIDRS` с явным production/staging allowlist; development/test default пустой. Native BlockList проверяет каждый hop; справа налево до первого недоверенного. Untrusted XFF игнорируется; trusted XFF обязан быть одним bounded literal-IP header. Equivalent IPv6 и mapped IPv4 нормализуются перед limiter. Trust-all, aliases, hostname и hop-count не поддерживаются. Подробный контракт — [deployment](../deployment.md#client-ip-и-доверенные-proxy).
- **Regression test:** [auth HTTP tests](../../apps/api/test/auth.http.integration.test.ts): реальный proxy с двумя clients, прямой spoof, untrusted peer, IPv4/IPv6 multiple hops, malformed/duplicate/oversized headers, canonical aliases и sensitive endpoint contexts; [config tests](../../packages/config/test/config.unit.test.ts).
- **Residual risk:** доверенный proxy и его сеть остаются trust boundary; proxy обязан корректно заменять/дополнять XFF. Разные IPv6 адреса не объединяются автоматически в `/64`. Shared NAT и распределённый abuse требуют измеренной edge policy.

## H3-003 — session contention

- **ID:** H3-003.
- **Severity:** P2.
- **Status:** before/after measurement и полный DB runner PASS 27 сентября; финальный integration run с пятью циклическими enumeration rounds также PASS. Clean deploy и итоговый Linux Docker smoke PASS; CI повторил полный integration 28 сентября.
- **Affected code:** `_resolve_session`, `authenticate`, `list_sessions` в опубликованной [004](../../packages/database/prisma/migrations/202609140001_authentication/migration.sql) и новой [005](../../packages/database/prisma/migrations/202609200001_auth_hardening/migration.sql).
- **Reproduction:** 004 вызывает User/session `FOR UPDATE` и touch при каждом authenticate, включая обычный `/users/me`; `listSessions` сначала выполняет authenticate. [Изолированный measurement fixture](../../scripts/test-auth-database-hardening.mjs) удерживает User lock и сравнивает 10/50/100 concurrent authenticate с pool=3 на 004 и 005. `test-results/auth-database-hardening.json` повторно завершился PASS 27 сентября: deterministic lock wait true→false; UPDATE 10/50/100→0; для 100 concurrent p95 476,564→70,606 ms в выбранном финальном integration запуске 15:02 UTC. Полные metrics и ограничения измерения — в verification.
- **Impact:** read-heavy dashboard сериализует запросы одного пользователя и создаёт лишние UPDATE/WAL/dead tuples.
- **Root cause:** один locking/touch path использовался и для безопасного чтения, и для security transitions.
- **Fix:** свежая сессия проверяется одним READ COMMITTED snapshot с User, epoch и MFA. Touch нужен только после пяти минут; он повторно проверяет state под прежним порядком User → session, поэтому конкурентные due touches дают один UPDATE. Absolute deadline неизменяем; истёкшая idle session не оживает. Session listing проверяет authorizing session и список в одном snapshot.
- **Regression test:** [auth integration](../../packages/database/test/auth.integration.test.ts): 50 fresh reads при удерживаемом User lock, отсутствие tuple UPDATE, 50 due touches, reset/logout-all/MFA/status/revoke/password-change против touch; measurement fixture собирает p50/p95/p99, lock waits, pool waits, UPDATE и приблизительный WAL.
- **Residual risk:** чтение, перекрывающее незавершённый state transition, может завершиться на более раннем допустимом snapshot; запрос после commit обязан увидеть новое состояние. Будущие protected writes обязаны повторно авторизовать transition внутри своей транзакции. Idle touch может отставать от последнего чтения до пяти минут; это сознательная консервативная граница expiry.

## H3-004 — SMTP failure domain

- **ID:** H3-004.
- **Severity:** P2.
- **Status:** исправлено на application и Compose уровнях; unit/HTTP/compiled flows и Linux Docker smoke PASS 28 сентября.
- **Affected code:** [server.ts](../../apps/api/src/server.ts), [service.ts](../../packages/auth/src/service.ts), [mail.ts](../../packages/auth/src/mail.ts), [app.ts](../../apps/api/src/app.ts), [Compose](../../infra/compose.dev.yml).
- **Reproduction:** `test-results/phase-3-hardening-baseline/composition-reproduction.json` фиксирует `smtpDownCoreReady: SERVICE_UNAVAILABLE`. Startup вызывал общий `service.ready()`, включавший SMTP, до listen. Независимый финальный deployment review также обнаружил `api.depends_on.mail-sink.condition: service_healthy`: даже исправленный Node entrypoint не запускался бы через Compose без готового SMTP.
- **Impact:** отказ почты блокирует verified login, существующие sessions и весь будущий core API.
- **Root cause:** email capability включена в обязательные core startup dependencies на двух уровнях: приложение и orchestrator dependency graph.
- **Fix:** core readiness проверяет DB/Redis; `emailReady()` и `/health/auth-email` показывают email capability отдельно. Email-dependent admission делает свежую SMTP проверку до account lookup и возвращает controlled 503 при outage. Email health probe coalesced/cached; transport failure не раскрывает адрес и credentials. API больше не зависит от healthy mail-sink в Compose; SMTP может подняться позже. Recovery не требует рестарта.
- **Regression test:** [service unit](../../packages/auth/test/service.unit.test.ts), [HTTP tests](../../apps/api/test/auth.http.integration.test.ts), [mail tests](../../packages/auth/test/mail.unit.test.ts), compiled boot и [100-user mixed/fault runner](../../scripts/test-auth-hardening.mjs) PASS. Дополнительный [Docker smoke](../../scripts/test-smoke.mjs) в CI поднял API без mail-sink, подтвердил core ready/email 503, затем запуск SMTP и recovery без restart. `bootstrap-docker/smoke.json` PASS, completed `2026-09-28T07:44:03.306Z`; 46 auth requests также PASS.
- **Residual risk:** успешный probe не гарантирует последующую доставку. Асинхронная отправка после commit остаётся bounded, но недолговечной; crash может потерять письмо. External production SMTP в этом аудите не подключается.

## H3-005 — invalidation ранее отправленного recovery token

- **ID:** H3-005.
- **Severity:** P2.
- **Status:** before/after reproduction и полный DB runner PASS 27 сентября.
- **Affected code:** `issue_verification`, `issue_password_reset` в 004/005.
- **Reproduction:** 004 помечает предыдущие активные tokens consumed при каждом новом неаутентифицированном запросе. Знания email и одного разрешённого resend достаточно; limiter лишь ограничивает частоту. Реальный before/after fixture подтвердил для reset и verification: исходная ссылка unusable на 004, usable на 005; второе немедленное письмо на 005 отклоняется cooldown.
- **Impact:** посторонний регулярно делает письмо пользователя непригодным для подтверждения или восстановления доступа.
- **Root cause:** выдача новой ссылки имела право отменять ранее выданные credentials без подтверждения владения email.
- **Fix:** максимум три одновременно активных token каждого вида, cooldown 60 секунд, прежние TTL 30/15 минут. Новая выдача не отзывает и не вытесняет живую ссылку; при cooldown/cap возвращается generic accepted без новой отправки. Reset/change потребляет все reset tokens, повышает epoch, отзывает sessions и LIVE grants; verification activation остаётся одноразовой.
- **Regression test:** [auth integration](../../packages/database/test/auth.integration.test.ts): cooldown, concurrent issuance/consume, cap, сохранение старых links, expiry/old epoch; [before/after fixture](../../scripts/test-auth-database-hardening.mjs).
- **Residual risk:** атакующий может расходовать resend budget и mailbox capacity, но не отменить уже доставленную действующую ссылку. При crash до доставки cap/cooldown могут задержать новое письмо до освобождения окна; durable email workflow остаётся отдельной production задачей.

## H3-006 — Retry-After

- **ID:** H3-006.
- **Severity:** P3.
- **Status:** исправлено; Redis и HTTP tests PASS.
- **Affected code:** limiter result, `AuthError.retryAfterMs`, auth error handler.
- **Reproduction:** baseline всегда выдаёт `Retry-After: 60`, хотя sensitive operation/identity window — 900 секунд. Real Redis tests отдельно исчерпывают global IP, operation, identity и несколько dimensions.
- **Impact:** клиент повторяет запросы до действительного окончания блокировки либо ждёт лишнее время.
- **Root cause:** boolean limiter API терял оставшийся TTL.
- **Fix:** структурированный `{ allowed, retryAfterMs }`; Redis вычисляет максимум фактически блокирующих TTL, включая dimension, исчерпанную самим denied attempt, и ожидание capacity slot. HTTP округляет вверх до целых секунд.
- **Regression test:** [Redis hardening](../../packages/auth/test/rate-limit-hardening.integration.test.ts), [service](../../packages/auth/test/service.unit.test.ts), HTTP границы 1/1000/1001/59999/899001 ms.
- **Residual risk:** состояние меняется при последующем трафике; header — корректная оценка текущего admission state, не резерв места.

## H3-007 — malformed cookie recovery

- **ID:** H3-007.
- **Severity:** P2.
- **Status:** исправлено; HTTP regression PASS.
- **Affected code:** `onRequest` и GET csrf в [auth-routes.ts](../../apps/api/src/auth-routes.ts).
- **Reproduction:** `ctp-dev-session=malformed` → baseline `GET /api/v1/auth/csrf` возвращает 401; новый csrf/login невозможно получить без очистки cookie. Независимый network fixture и тест до исправления подтверждают этот путь.
- **Impact:** некорректное сохранённое browser state блокирует обычный login UX.
- **Root cause:** blanket cookie validation срабатывала раньше bootstrap CSRF route.
- **Fix:** только origin-checked/rate-limited GET csrf удаляет malformed cookie и создаёт новую preauth identity/CSRF secret. Protected reads и mutations продолжают отвечать 401; cross-origin запрос не очищает cookie.
- **Regression test:** [HTTP security](../../apps/api/test/auth.http.integration.test.ts): malformed protected/mutation denial, cross-origin no-clear, новая identity, старый CSRF недействителен, обычный login успешен; oversized/duplicate cookies остаются запрещёнными.
- **Residual risk:** frontend должен повторить GET csrf после неудачной authentication; malformed cookie не признаётся session ни на одном пути.

## H3-008 — historical snapshot и MFA

- **ID:** H3-008.
- **Severity:** P2.
- **Status:** реальный before/after fixture и полный DB runner PASS 27 сентября.
- **Affected code:** SQL auth entrypoints, `_requires_mfa`, [auth-database.ts](../../packages/database/src/auth-database.ts).
- **Reproduction:** VOLATILE helper получает свежий snapshot при READ COMMITTED, но не отменяет snapshot caller-owned REPEATABLE READ. Реальный fixture сохраняет старые credentials, другой connection под User lock включает MFA, затем прежняя транзакция вызывает create_session: 004 создала password-only session, 005 отвергла historical snapshot с `25001`. Добавлен negative matrix REPEATABLE READ/SERIALIZABLE для всех token entrypoints и credentials, включая неизвестные identities.
- **Impact:** альтернативный SQL caller или изменённый default isolation может использовать старую assurance policy после MFA commit.
- **Root cause:** freshness предполагала конкретный isolation level, но функция не проверяла это условие.
- **Fix:** явный READ COMMITTED в auth pool/readiness; private VOLATILE guard в credentials и общем token-validation helper отклоняет historical transaction isolation до поиска/изменений. Migration 005 не меняет старые опубликованные SQL-файлы.
- **Regression test:** [auth integration](../../packages/database/test/auth.integration.test.ts) и [before/after fixture](../../scripts/test-auth-database-hardening.mjs).
- **Residual risk:** SQL auth API намеренно несовместим с caller-owned historical snapshots. Future transactions должны соблюдать этот контракт и общий User lock для assurance transitions.

## H3-009 — effective privileges и drift

- **ID:** H3-009.
- **Severity:** P2.
- **Status:** проверки и узкие grants реализованы; negative DB tests PASS в повторе 27 сентября.
- **Affected code:** [runtime database](../../packages/database/src/index.ts), [auth database](../../packages/database/src/auth-database.ts), [auth-role-boundary](../../packages/database/src/auth-role-boundary.ts), 005.
- **Reproduction:** технический review обнаружил недостаточную полноту startup/readiness: прямой column grant на passwordHash и расширение прав function owner нужно проверять effective privilege predicates, а не только атрибутами/членством ролей. 004 выдаёт владельцу широкие табличные права, которые автоматически охватывают будущие columns. Negative fixtures добавляют secret SELECT, role/stepUp UPDATE, private function EXECUTE и изменяют search_path.
- **Impact:** ошибочное provisioning/grant drift может остаться незамеченным и нарушить runtime/function-owner boundary. Это hardening от привилегированного configuration drift, не утверждение о публичном HTTP exploit.
- **Root cause:** role checks не выражали точный ожидаемый column/function contract.
- **Fix:** 005 перечисляет column grants и отзывает PUBLIC TEMP; runtime/auth/owner readiness запрещает effective database TEMP/CREATE. Проверяются forbidden secrets, role inheritance, owners, PUBLIC EXECUTE, safe search_path, private helper exposure и FORCE RLS шести security tables. В первом DB запуске обнаружено, что string-to-regclass privilege resolution для роли без schema USAGE выдаёт PostgreSQL 42501 вместо safe boolean: исправление использует catalog OIDs; повтор 27 сентября подтвердил safe classification.
- **Regression test:** [auth integration](../../packages/database/test/auth.integration.test.ts): все secret columns для ctp_api, raw app access/SET ROLE/CREATE для ctp_auth, owner privilege drift, временные shadow tables/search_path, восстановление readiness после revoke.
- **Residual risk:** migration/cluster administrator остаётся привилегированной доверенной стороной. Checks обнаруживают drift, но не заменяют IAM и контролируемые migrations.

## H3-010 — email grammar между слоями

- **ID:** H3-010.
- **Severity:** P3.
- **Status:** Node/SMTP corpus, before/after divergent cases и SQL corpus PASS 27 сентября.
- **Affected code:** [mailbox.ts](../../packages/auth/src/mailbox.ts), service/mail validation, SQL signup.
- **Reproduction:** реальный 004→005 fixture подтвердил: leading dot, local part длиннее 64 и domain label длиннее 63 приняты 004 и отклонены 005 (3→0 accepted). Определён детерминированный [corpus](../../tests/fixtures/auth-email.ts) с uppercase/spaces, dots/hyphens, 64/65, 63/64, total 254/255, Unicode, controls и CRLF.
- **Impact:** разные SQL/Node callers получают различные представления о допустимом account email; будущие изменения легко создают delivery inconsistencies.
- **Root cause:** независимые несовпадающие regular expressions вместо одного product contract.
- **Fix:** общий Node predicate для service/SMTP и эквивалентная ASCII grammar в 005. HTTP передаёт normalized value; SQL требует уже канонический lowercase/trimmed адрес. Internationalized mailboxes сознательно не поддерживаются.
- **Regression test:** [mailbox unit](../../packages/auth/test/mailbox.unit.test.ts), тот же corpus в [auth integration](../../packages/database/test/auth.integration.test.ts), три divergent примера в before/after fixture.
- **Residual risk:** проверка синтаксиса не доказывает существование mailbox или deliverability; Unicode/EAI потребует отдельного product decision и согласованных изменений всех слоёв.

## H3-011 — composite readiness single-flight

- **ID:** H3-011.
- **Severity:** P2.
- **Status:** исправлено; unit regression и финальный runtime запуск 27 сентября PASS.
- **Affected code:** server PostgreSQL probe composition и [health.ts](../../apps/api/src/health.ts).
- **Reproduction:** baseline composition artifact фиксирует `healthDuplicatePendingSiblingCalls: 2`: один DB probe быстро reject, второй ещё выполняется, следующий health poll запускает sibling снова.
- **Impact:** readiness polling может накапливать лишнюю работу/ожидания DB pool во время частичного отказа.
- **Root cause:** Promise.all завершал внешний composite probe раньше завершения всех его underlying operations, нарушая обещание single-flight.
- **Fix:** composite database readiness использует Promise.allSettled и остаётся busy до завершения обоих checks; наружу возвращается только безопасная ошибка. Общий deadline не снимает accounting незавершённой работы.
- **Regression test:** [health unit](../../apps/api/test/health.unit.test.ts), runtime blackhole/deadline checks и общий load/failure runner.
- **Residual risk:** timeout ограничивает ожидание caller, но не мгновенно прекращает любую native/backend operation; bounded pools и shutdown остаются обязательны.

## H3-012 — request ID: defect не подтверждён

- **ID:** H3-012.
- **Severity:** P3, review/documentation.
- **Status:** проверено; менять совместимый diagnostic contract не требуется.
- **Affected code:** genReqId, completion logs/error envelopes; schema содержит будущий audit requestId, текущего auth audit writer нет.
- **Reproduction:** клиент может повторно передать допустимый X-Request-Id. Поиск usages обнаружил только diagnostic consumers; HTTP regression с тем же ID не превращает invalid session в principal.
- **Impact:** correlation ID нельзя считать уникальным security event; текущая реализация этого не делает.
- **Root cause:** это намеренно клиентский correlation field, а не доказанный auth defect.
- **Fix:** [HTTP contract](../phase-3/auth-api.md) явно запрещает использовать поле как principal, idempotency key или уникальную audit identity; будущим writers нужны собственные server IDs.
- **Regression test:** existing invalid-ID sanitization и новый repeated-ID authentication test.
- **Residual risk:** будущие consumers могут неверно интерпретировать поле; это необходимо проверять при добавлении audit/idempotency.

## H3-013 — revoked cookie и tampered preauth: defect не подтверждён

- **ID:** H3-013.
- **Severity:** P3, проверка исходной гипотезы.
- **Status:** независимый HTTP test прошёл на baseline до production изменений.
- **Affected code:** CSRF binding, freshCsrf и login/session replacement.
- **Reproduction:** revoked canonical session получает 401 на protected read, может получить csrf и выполнить обычный login; tampered signed preauth получает свежую identity через GET. Новый session token отсутствует в JSON.
- **Impact:** ручная очистка browser state не требуется для этих двух случаев; H3-007 относится именно к malformed session token.
- **Root cause:** CSRF binding не является authentication, а обычный login проверяет credentials заново.
- **Fix:** изменений семантики не требуется; сценарии закреплены отдельным regression.
- **Regression test:** `recovers from revoked sessions and tampered preauth without trusting a repeated request ID` в HTTP suite, PASS до и после исправлений.
- **Residual risk:** frontend обязан сохранять cookie и менять cached csrfToken после authentication transitions; backend не может исправить произвольно нарушенный клиентский протокол.

## H3-014 — retention auth state

- **ID:** H3-014.
- **Severity:** P3; обязательная задача до production.
- **Status:** policy определена, автоматического cleanup job нет.
- **Affected code:** `user_session`, `email_verification_token`, `password_reset_token` и их tokenHash/tenant/expiry indexes.
- **Reproduction:** поиск writers/migrations не обнаружил scheduled deletion; consume/revoke обновляют timestamp, expiry лишь исключает строку из authentication. Следовательно, общий объём таблиц и indexes растёт со временем.
- **Impact:** накопление dead auth history увеличивает storage/index/vacuum cost; уникальный hash lookup остаётся индексным, но его размер не ограничен TTL проверки.
- **Root cause:** security TTL и физическая retention — разные механизмы; реализован только первый.
- **Fix:** обязательный production job: expired/consumed email tokens хранить минимум семь дней после более позднего expiresAt/consumedAt; revoked/expired sessions — минимум 30 дней после последнего применимого deadline/revoke timestamp. Не удалять действующие records. Выделенная maintenance role, небольшие bounded batches, lock timeout, наблюдаемые progress/errors, index/vacuum monitoring; auth runtime DELETE не получает. Durable audit evidence хранить отдельно и не удалять этим job. Конкретный SQL/job ещё не реализован и не объявляется проверенным.
- **Regression test:** реализация job должна добавить boundary/active-record/concurrent-consume tests и dry-run counts до production; текущие auth expiry tests не являются доказательством cleanup.
- **Residual risk:** до запуска этого job физический рост продолжается. Это явная production prerequisite, а не скрытое утверждение о bounded database retention.
