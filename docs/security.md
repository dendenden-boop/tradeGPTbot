# Security — проект PHASE 0

Дата: **2026-09-05**. Основа: [архитектура](architecture.md), [требования](phase-0/requirements.md). Ни один контроль или тест ниже пока не реализован и не проверен; это условия будущей приёмки.

## Границы доверия и угрозы

Активы: биржевые credentials, сессии/2FA, финансовый ledger, intents, tenant data и разрешения LIVE. Недоверенные стороны: браузер, другой tenant, входящие exchange payloads, задания очереди. Отдельные границы: edge→API, API→БД, execution→signer, signer→KMS/биржа, приложение→telemetry, CI→production. Оператор приложения не получает права KMS decrypt.

| Граница / угроза                       | Проектный контроль                                  | Будущая проверка                               | Остаточный риск                          |
| -------------------------------------- | --------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| Browser→API: захват сессии, CSRF       | HttpOnly cookie, CSRF token, Origin, step-up        | Replay, чужой Origin, revoke при WS            | XSS способен действовать от пользователя |
| Tenant→tenant: IDOR                    | Ownership на каждой операции, RLS, tenant-scoped FK | Матрица двух пользователей REST/WS/jobs/export | Ошибки privileged кода                   |
| DB/backup→злоумышленник: ключи         | Envelope encryption, KMS отдельно                   | Украденный dump без KMS не расшифровывается    | Метаданные остаются видимыми             |
| Ciphertext→signer: подмена             | GCM tag и AAD привязывают владельца/среду           | Swap tenant/env/version, повреждённый tag      | Компрометация signer                     |
| Queue→execution: replay/поддельный job | Только ID; повторное чтение intent и CAS            | Duplicate, stale lease, изменённый payload     | Биржа не участвует в DB-транзакции       |
| Signer→биржа: SSRF, вывод средств      | Allowlist endpoints/methods, проверенный профиль    | Произвольный URL, withdrawal route             | Убыток возможен и через торговлю         |
| Runtime→секрет: RCE/dependency         | Изоляция процесса, минимальные IAM/egress           | Проверка прав workload и образа                | Plaintext в памяти signer                |
| Admin→production: злоупотребление      | Role separation, MFA, immutable audit sink          | Попытка decrypt/смены владельца/обхода gate    | Сговор привилегированных лиц             |
| Exchange/data→risk: stale/malformed    | Schema, freshness, reconciliation, fail-closed      | Gap, clock skew, disconnect, NaN               | Сбой или ошибочные данные биржи          |
| Logs/metrics→утечка                    | Allowlist полей, redaction, запрет body capture     | Secret canaries во всех sinks                  | Ошибка стороннего агента telemetry       |

## Credentials и шифрование

Проект: новая случайная 256-bit DEK на каждую запись версии credentials; AES-256-GCM, случайный 96-bit nonce, 128-bit tag. Пара DEK/nonce никогда не переиспользуется. Канонический AAD: `tenantId, connectionId, exchange, environment, credentialVersion, schemaVersion`; signer сверяет его с доверенными DB-данными. Хранить ciphertext, nonce, tag, wrapped DEK и KMS key/version; KEK остаётся в KMS. Основание: [envelope encryption](https://docs.cloud.google.com/kms/docs/envelope-encryption), [Node crypto](https://nodejs.org/api/crypto.html#cryptocreatecipherivalgorithm-key-iv-options).

KMS-ротация создаёт новый KEK version и отдельный возобновляемый rewrap job; rewrap не меняет credentialVersion/AAD. Проверить расшифровку до удаления старой обёртки; старые KEK нужны для сохранённых backups. При смене биржевого ключа — новая credentialVersion, DEK и nonce, проверка permissions, отзыв старого ключа, повторное разрешение LIVE. При подозрении на утечку одного rewrap недостаточно: остановить dispatch и отозвать credentials на бирже.

Расшифровка разрешена только signer/private-connector workload; его интерфейс принимает разрешённую операцию и durable intent ID, а не произвольные bytes для подписи. API/web/strategy/admin не имеют decrypt. Очередь содержит ссылки, не ключи. Credentials не возвращаются клиенту, не попадают в localStorage, SSR props, traces, логи или error bodies. Первичный ручной ввод неизбежно находится в форме браузера кратковременно; dedicated enrollment endpoint передаёт его в credential boundary без журналирования, затем форма очищается.

При подписи plaintext secret/DEK кратковременно существует в памяти. Ограничить lifetime/cache, отключить core/heap dumps, исключить swap dumps и debugger в production; best-effort очистка Buffer не гарантирует zeroization в JS. Runtime compromise остаётся существенной угрозой. KMS unavailable, tag mismatch или неизвестная версия блокируют dispatch.

## Tenant isolation, auth и LIVE

REST ownership проверяется по principal сессии, включая parent-child связи. WS проверяет Origin, сессию, tenant и connection каждой подписки; истечение/отзыв закрывает private streams. Job tenant — недоверенная подсказка; consumer повторно разрешает владельца из БД. RLS использует `USING`/`WITH CHECK`, tenant context только внутри транзакции; отсутствующий context запрещает доступ. Runtime-роли не owner/superuser/BYPASSRLS; migrations, API, signer и analytics имеют разные grants. RLS не защищает от superuser; owner требует FORCE, отдельные table-wide операции обходят RLS. [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

Пароли: Argon2id с индивидуальной солью; стартовый минимум OWASP — 19 MiB, t=2, p=1; реальный cost фиксировать после benchmark с ограничением параллельных login. [Password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

Сессия — случайный opaque token, сервер хранит hash и revocation state; cookie `Secure; HttpOnly; SameSite=Lax`, host-only, без URL-token. Ротация после login/step-up; idle/absolute TTL, logout-all. CSRF token и Origin обязательны для mutation; SameSite не заменяет CSRF. Предлагаются idle 30 минут, absolute 12 часов, step-up ≤5 минут. [Session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

2FA обязательна для admin, подключения LIVE и rearm: предпочтительно WebAuthn, TOTP как поддерживаемый вариант. TOTP secret шифруется; принятый timestep помечается атомарно против replay. Recovery codes одноразовые, хранятся hash; reset отзывает сессии и LIVE grants, требует повторной идентификации и уведомления. Rate limits действуют на login, 2FA, reset и recovery. [MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)

Withdrawal endpoints отсутствуют. Обнаруженное право withdrawal или непроверяемые permissions блокируют LIVE onboarding; IP allowlist применяется где поддерживается. Разрешение LIVE привязано к tenant/connection/environment/credentialVersion и risk policy. Перед каждым dispatch сервер проверяет grant, kill switch, limits, freshness и reconciliation. Недоступность обязательной проверки означает отказ; browser confirmation не заменяет server gate. До security/risk/execution gates production dispatch закрыт.

## Дополнительные проверки входа и восстановления доступа

Email verification/password reset: криптографически случайные одноразовые tokens, только hash в БД, короткий TTL и atomic consumedAt. Одинаковые ответы для существующего/неизвестного email, лимит частоты по account/IP, trusted origin для reset URL, запрет open redirect. Reset/change password отзывает прежние сессии; change email и удаление account требуют recent authentication. Account deletion сначала останавливает стратегии, разрешает outstanding orders по явной политике, отзывает credentials/grants, затем pseudonymizes допустимые данные; финансовое evidence не удаляется каскадом.

CSP и output escaping ограничивают XSS; secure headers/HSTS на production edge. Parameterized SQL и schema allowlist защищают от injection/mass assignment. Не выполнять пользовательский JS/shell; DSL имеет depth/size/cost limits. Отклонять prototype keys в небезопасных merge boundaries, ограничивать JSON/body/gzip size, число WS подписок и concurrent backtests. SSRF защита включает allowlist протокола/host/port/path, запрет произвольных redirects и проверку egress/DNS политикой инфраструктуры. Тестировать dependency/telemetry leakage, session fixation, reset races, credential stuffing, replay, privilege escalation и экспорт чужих данных.
