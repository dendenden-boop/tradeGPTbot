# PHASE 3 — запуск и эксплуатационные границы

Для существующей рабочей копии сохраните `.env` и создайте только новый `.env.auth`: `pnpm auth:env:init`. Генератор никогда не перезаписывает существующие файлы и не меняет пароль PostgreSQL в сохранённом volume. Для новой копии сначала выполните `pnpm env:init`.

```sh
pnpm install --frozen-lockfile
pnpm auth:env:init
docker compose --env-file .env --env-file .env.auth -f infra/compose.dev.yml up --build --wait --wait-timeout 60
```

Compose provision применяет миграции и создаёт отдельные `ctp_api_login` и `ctp_auth_login`. Повторный запуск проверяет существующие credentials, не меняет их. Затем запускается API; его реальный entrypoint требует auth config и безопасные роли. Runtime image не содержит Prisma CLI, тестового SMTP server, migration credentials или dev tooling. `local-tools` — отдельный development target с migration CLI и локальным SMTP sink.

При запуске Node вне Docker:

```sh
docker compose --env-file .env --env-file .env.auth -p ctp-local -f infra/compose.dev.yml -f infra/compose.local.yml up --build --wait --wait-timeout 60 postgres redis mail-sink
pnpm build
pnpm auth:setup
pnpm dev
```

`pnpm start` читает сначала `.env`, затем `.env.auth`; переменные самого процесса имеют приоритет над env-файлами. Не оставляйте в окружении shell старый `DATABASE_URL` с DDL-ролью. Local provisioning допускает только development/test, фиксированные localhost/container назначения и сгенерированные hex credentials. Для собственной инфраструктуры используйте [контракт ролей и миграций](database-security.md).

| Настройка                         | Назначение                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                    | LOGIN с членством только в `ctp_api`, доступ через tenant RLS                                                                                |
| `DATABASE_AUTH_URL`               | Другой LOGIN с членством только в `ctp_auth`, та же БД/host, EXECUTE-only API                                                                |
| `DATABASE_MIGRATION_URL`          | Только отдельный DDL job; не передаётся API-контейнеру                                                                                       |
| `AUTH_ORIGIN`                     | Точный origin сайта без завершающего `/`, path, query или credentials; HTTPS для staging/production, HTTP только loopback в development/test |
| `AUTH_CSRF_SECRET`                | Случайные 32 bytes в 64 lowercase hex characters; генерировать секретом окружения, не коммитить                                              |
| `SMTP_HOST`, `SMTP_PORT`          | Реальный SMTP endpoint; парольные credentials не кодируются в URL                                                                            |
| `SMTP_SECURE`, `SMTP_REQUIRE_TLS` | Значения `true`/`false`; deployment требует implicit TLS или обязательный STARTTLS, сертификаты проверяются                                  |
| `SMTP_USER`, `SMTP_PASSWORD`      | Оба заданы либо оба отсутствуют для разрешённого relay                                                                                       |
| `SMTP_FROM`                       | Один mailbox, без display name и управляющих символов                                                                                        |

Пароли, cookie/CSRF и email tokens не печатаются в logs. Публичный error envelope содержит code/message/requestId, без SQL/SMTP diagnostics. `auth_mail_delivery_failed` сообщает об отказе отправки без адреса и токена. Автоматической повторной доставки после рестарта пока нет; применяется resend.

SMTP sink принимает только получателей в `.invalid`, хранит до 128 писем до одного часа в памяти и никогда не пересылает их наружу. `GET http://127.0.0.1:8025/messages` доступен для локальной проверки; не публикуйте этот development endpoint во внешней сети. Веб-страницы `/verify-email` и `/reset-password` будут реализованы в PHASE 17. Пока token из fragment тестового письма передаётся соответствующему API по [HTTP-контракту](auth-api.md); API не публикует сам token.

Production bootstrap отдельно проверяет оба DB role boundaries, схему 004, Redis и SMTP до listen. После старта liveness не зависит от backend. Readiness проверяет оба рабочих DB pools и Redis; SMTP отказы обрабатываются на email operations. Shutdown закрывает health, runtime/auth pools, limiter, native hashing и почтовые операции; максимальный процессный deadline 10 секунд.

Подключение внешнего SMTP, публичная публикация сайта, торговля и production release не выполняются локальными test runners. Проверки используют только собственные disposable Docker проекты; reset удаляет только БД, созданную самим runner.
