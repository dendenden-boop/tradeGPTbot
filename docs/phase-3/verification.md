# PHASE 3 — реализация и проверка Authentication

Состояние на 20 сентября 2026: backend реализован; локальные unit/HTTP, integration, clean deployment и Linux Docker smoke прошли. Ожидается GitHub CI для этого изменения. Основание: [требования](requirements.md), [план этапов](../phase-0/implementation-plan.md), завершённый [аудит PHASE 0–2](../audit-phases-0-2.md).

## Реализовано

Регистрация USER, подтверждение и повторная отправка email, login/logout, восстановление и смена пароля, получение/ротация/отзыв сессий, logout-all и чтение своего профиля. Пароль хранится как Argon2id PHC; session и одноразовые email tokens — только в виде SHA-256. Cookie HttpOnly, SameSite=Lax, host-only; для HTTPS используются Secure и `__Host-` prefix. Изменяющие запросы требуют точный Origin и header-only CSRF, связанный с preauth или session identity.

Миграция 004 добавляет product role и узкую auth boundary. `ctp_api` получает доверенный principal и выполняет tenant-scoped операции; `ctp_auth` может только вызывать разрешённые SQL-функции. NOLOGIN-владелец функций не имеет BYPASSRLS. Runtime проверяет прямые и наследованные полномочия до listen и на readiness. Миграции 001–003 не изменены.

User lock сериализует token/session transitions. Вход после Argon2 повторно проверяет hash/epoch, поэтому параллельный reset/logout-all не создаёт сессию со старыми credentials. Reset/change-password атомарно отзывают сессии и LIVE grants своего пользователя; foreign grants сохраняются. Absolute expiry не продлевается при rotation. ADMIN и включённая MFA закрывают password-only доступ до реализации полноценного verifier.

Redis выполняет атомарное ограничение попыток до дорогого хеширования. HMAC скрывает email/IP/token в ключах, число ключей и очереди ограничены, повреждённое состояние и недоступность backend закрывают доступ. Настоящий SMTP transport имеет TLS validation, deadlines и ограничение параллелизма. Письма в тестах принимаются только локальным sink без внешней пересылки.

## Проверки и границы доказательств

| Команда / сценарий                         | Последний подтверждённый результат                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`, повторные lint/format/unit   | PASS 20 сентября: formatter, ESLint, TypeScript, 306 unit + 30 HTTP, workspace build; с 122 DB/Redis и 3 service tests всего 461 тест                                                             |
| Mail-sink Host/Origin regression           | PASS: один тест с настоящим HTTP; отклоняет DNS rebinding Host и cross-site запросы                                                                                                               |
| `pnpm test:database`                       | PASS 20 сентября в составе integration: 110 PostgreSQL (19 auth) + 12 Redis, fresh/repeat/upgrade/non-BYPASS owner/reset; full compiled auth runtime                                              |
| Compiled auth runtime                      | PASS 20 сентября: 46 HTTP requests с реальными PostgreSQL/Redis/SMTP/Argon2id, no secret canaries in logs; shutdown 36 мс                                                                         |
| `pnpm test:runtime`                        | PASS 20 сентября: скомпилированный health/lifecycle fixture, blackhole sockets, 64 concurrent readiness, logs/shutdown; full auth entrypoint проверяется отдельно                                 |
| `pnpm audit --json`                        | PASS 20 сентября: 0 известных уязвимостей / 404 зависимости                                                                                                                                       |
| Независимый обзор auth-кода                | Конкретных эксплуатируемых находок не выявлено; это ограниченный review, не замена security tests                                                                                                 |
| `pnpm test:clean`                          | PASS 20 сентября: fresh source, frozen offline install/build, exact offline deploy после policy verification; изолированные API/database imports, native Argon2id, PostgreSQL WASM, без dev tools |
| `pnpm test:integration`, `pnpm test:smoke` | PASS 20 сентября: ещё 3 real-service tests; Linux runtime image, 46 auth HTTP requests, PostgreSQL/Redis outage/recovery, non-root, secret-free logs и SIGTERM за 2308 мс                         |
| GitHub CI                                  | Ещё не запущен для PHASE 3                                                                                                                                                                        |

Машинные отчёты и логи находятся в игнорируемом `test-results/`. Отчёт PHASE 0–2 и старые CI ссылки не используются как доказательство прохождения новых auth-проверок. Security tests проверяют реальные конкурирующие транзакции, single-use/replay, idle/absolute expiry, чужую сессию, reset-vs-login и включение MFA во время ожидания User lock. HTTP suite дополнительно проверяет duplicate raw headers/cookies, Unicode/body bounds, origin, CSRF identity transitions и безопасные ошибки.

Первый Redis corruption test обнаружил, что Lua-конструкция с fallback в ноль трактовала нечисловой счётчик как отсутствие ключа. Исправление проверяет формат/диапазон всех counters до изменения buckets; набор содержит восемь повреждённых значений. Review расширил проверку наследованных прав auth-owner и добавил ограничение смены пароля по аккаунту независимо от IP. Локальный почтовый inspector дополнительно защищён от подмены Host.

Одновременные clean/Docker builds исчерпали доступную память Windows; тяжёлые прогоны выполняются последовательно. Проверки не удалены и work factor Argon2 не снижен. Clean deployment проверяет точные PHC-параметры независимо от допустимого порядка их кодирования библиотекой.

## Эксплуатационные ограничения

Web UI и страницы email links относятся к PHASE 17. Полный TOTP enrollment/recovery, KMS и управление удалением аккаунта остаются будущей работой согласно [API/MFA архитектуре](auth-api.md). Уже требующая MFA учётная запись не получает парольный обход. LIVE dispatch и финансовые writers не реализуются этим этапом.

SMTP send следует после DB commit и не является durable exactly-once delivery: авария процесса может потребовать resend. Plaintext recovery token не хранится в outbox. Реальный внешний SMTP не подключался и production deliverability не подтверждена. TLS и провайдерские настройки проверяются отдельно перед production release.

Argon2id использует 64 MiB, t=3, p=1; два выполняющихся hash и восемь ожидающих. [Замеры и зависимости](dependencies.md) описывают оборудование и команды. Эти небольшие замеры не подтверждают performance gate всей торговой платформы.

## Изменённые компоненты

Auth package содержит password/SMTP/Redis/service ports и тесты. Database package содержит миграцию 004, product role, auth repository, общий DSN validator и security integration tests. API содержит auth routes, composition, strict validation, safe logging и закрытие всех ресурсов. Config отдельно проверяет auth origin, SMTP, CSRF и две runtime роли. Development tooling подготавливает роли, изолированный mail sink и уникальные env secrets. Runtime/clean/integration/Docker runners проверяют новый production graph; CI выполняет те же gates на Linux и Windows. Ниже перечислены все 69 изменённых/добавленных исходных файлов; секреты, generated code и локальные test-results не входят в commit.

Следующий этап после успешного закрытия PHASE 3 — PHASE 4, Exchange Core.

## Список файлов этапа

```text
.env.example
.github/workflows/ci.yml
.pnpmfile.mjs
README.md
apps/api/package.json
apps/api/src/app.ts
apps/api/src/auth-routes.ts
apps/api/src/health.ts
apps/api/src/server.ts
apps/api/test/auth.http.integration.test.ts
docs/architecture.md
docs/database.md
docs/deployment.md
docs/phase-0/implementation-plan.md
docs/phase-3/auth-api.md
docs/phase-3/database-security.md
docs/phase-3/dependencies.md
docs/phase-3/operations.md
docs/phase-3/requirements.md
docs/phase-3/verification.md
docs/security.md
infra/Dockerfile
infra/compose.dev.yml
package.json
packages/auth/package.json
packages/auth/src/index.ts
packages/auth/src/mail.ts
packages/auth/src/password.ts
packages/auth/src/rate-limit.ts
packages/auth/src/service.ts
packages/auth/test/mail.unit.test.ts
packages/auth/test/password-capacity.unit.test.ts
packages/auth/test/password.unit.test.ts
packages/auth/test/rate-limit.integration.test.ts
packages/auth/test/rate-limit.unit.test.ts
packages/auth/test/service.unit.test.ts
packages/auth/tsconfig.build.json
packages/config/src/index.ts
packages/config/test/auth-config.unit.test.ts
packages/database/prisma/migrations/202609140001_authentication/migration.sql
packages/database/prisma/schema.prisma
packages/database/src/auth-database.ts
packages/database/src/connection-options.ts
packages/database/src/index.ts
packages/database/test/auth.integration.test.ts
packages/database/test/dsn-contract.unit.test.ts
packages/logger/src/index.ts
pnpm-lock.yaml
pnpm-workspace.yaml
scripts/auth-runtime-child.mjs
scripts/auth-test-flow.mjs
scripts/benchmark-auth.mjs
scripts/docker-test-utils.mjs
scripts/init-auth-env.mjs
scripts/mail-sink.mjs
scripts/mail-sink.unit.test.mjs
scripts/pnpmfile.unit.test.mjs
scripts/provision-development.mjs
scripts/runtime-child.mjs
scripts/test-auth-runtime.mjs
scripts/test-clean-install.mjs
scripts/test-database.mjs
scripts/test-integration.mjs
scripts/test-runtime.mjs
scripts/test-smoke.mjs
tsconfig.json
vitest.database.config.ts
vitest.http.config.ts
vitest.shared.ts
```
