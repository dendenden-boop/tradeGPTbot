# PHASE 3 Hardening — verification

Состояние: **READY FOR PHASE 4**. Hardening проверен локально и в [CI run 36392668471](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/36392668471) для commit [20f25872394c9d71fefa98edffe2aa5b50a316d5](https://github.com/dendenden-boop/tradeGPTbot/commit/20f25872394c9d71fefa98edffe2aa5b50a316d5): все три jobs PASS, включая Linux Docker smoke с запуском без SMTP и восстановлением без restart. Локальный integration подтвердил 175 PostgreSQL/Redis tests, три service tests, before/after SQL benchmark, compiled auth и 100-user load с пятью циклическими enumeration rounds; CI повторил integration и load. Format/lint/typecheck/unit/HTTP/runtime/docs/Argon benchmark и clean deploy PASS. Dependency audit 28 сентября: 0 vulnerabilities / 404 dependencies; migrations 001–004 и lockfile неизменны. Прежний [отчёт PHASE 3](../phase-3/verification.md) — история commit `fac5c07`. Требования — [requirements](requirements.md), разбор находок — [findings](findings.md).

## Исходное состояние и сохранность migrations

Исходный commit: `fac5c07065dc9980a970a28e30a9c9530ce1b09b`. До изменений `git status --short` был пуст. Baseline запуск выполнен 20–21 сентября 2026; аудит продолжен 26–28 сентября. Exchange Core и биржевые адаптеры не реализуются в этой задаче.

До изменений зафиксированы SHA-256 опубликованных migrations в `test-results/phase-3-hardening-baseline/migration-hashes.json`:

| Migration           | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| 001 initial         | `82D5FF35633DEB1E6C0EC6B185BA879EB93F692E9CC560BE58E32874B527F618` |
| 002 integrity       | `CF5F308C5F6AC2425091478DCFF1882ECF5193AF53CC176F99617C602F4D715F` |
| 003 audit integrity | `FD94703D9D3E38DAD9C34329D861583A6C16CC0A75DB26968FEC4EB5547C8AF5` |
| 004 authentication  | `13DB0EA6AD0C329BC8570A78036FFCA5175E04A16BB6364BFA010A661450A400` |

Изменения SQL находятся только в [005](../../packages/database/prisma/migrations/202609200001_auth_hardening/migration.sql). Повторное сравнение SHA-256 27 сентября подтвердило совпадение всех четырёх исходных hashes. `git diff --quiet -- pnpm-lock.yaml` завершился exit 0: lockfile не изменён. Это дополняет фактический successful fresh/upgrade/repeat/non-BYPASS owner/reset runner и не заменяет его.

## Baseline: реальные команды

Manifest запусков: `test-results/phase-3-hardening-baseline/results.json`. Артефакты `test-results` локальные и игнорируются Git; здесь приведены их имена, без ссылок на несуществующие в checkout CI файлы.

| Команда                 | Exit status | Результат                                                                            |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------ |
| `pnpm format:check`     | 0           | PASS                                                                                 |
| `pnpm lint`             | 0           | PASS                                                                                 |
| `pnpm typecheck`        | 0           | PASS                                                                                 |
| `pnpm test:unit`        | 0           | 306 tests PASS                                                                       |
| `pnpm test:http`        | 0           | 30 tests PASS                                                                        |
| `pnpm build`            | 0           | PASS, prerequisite compiled checks                                                   |
| `pnpm test:database`    | 1 → 0       | Первый запуск: Docker daemon выключен; повтор после запуска daemon PASS              |
| `pnpm test:runtime`     | 0           | PASS                                                                                 |
| `pnpm test:integration` | 0           | PASS                                                                                 |
| `pnpm test:smoke`       | 1 → 1 → 0   | Причина и исправление test harness ниже                                              |
| `pnpm test:clean`       | 1 → 0       | Host commit-memory exhaustion; повтор после освобождения owned Docker resources PASS |
| `pnpm docs:check`       | 0           | PASS                                                                                 |
| `pnpm audit --json`     | 0           | 0 vulnerabilities, 404 dependencies                                                  |

Baseline всего: **461 тест** = 306 unit + 30 HTTP + 122 PostgreSQL/Redis integration + 3 real-service tests. Повторные database/integration запуски не увеличивают это число. Compiled auth flow, runtime fault fixtures, smoke и clean acceptance — отдельные сценарии, не дополнительные unit test counts.

Smoke сначала ожидал API recovery, пока сам PostgreSQL ещё проходил recovery. Наблюдаемый запуск без изменений production code подтвердил ошибочный prerequisite budget. Harness сначала ждёт работоспособность самой зависимости, затем проверяет API deadline. После исправления: PostgreSQL recovery 7700 ms, следующий API ready 5 ms; Redis recovery 2630 ms, API ready 10 ms. Артефакты: `smoke-first.json`, `smoke-observed.json`, `smoke.json`, `test-smoke-fixed-harness.log`. Это исправление теста не доказывает отсутствие иных startup defects.

Clean install первый раз исчерпал Windows commit memory; оставалось примерно 0,58 GB. Остановлен только ранее запущенный для этого задания Docker Desktop после проверки отсутствия контейнеров. Системные лимиты, pagefile/WSL настройки и чужие приложения не менялись. Повтор clean PASS записан в `test-clean-retry-memory.log` и `clean-install.json`. После разбирательства baseline gate открыт; исходные сбои не скрыты.

## Воспроизведения до исправления

| Evidence                                                              | Наблюдение                                                                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-limiter-hardening-before.json`                                  | Один IP/один endpoint: 9997 новых identities, index 10 000, другой IP denied; при трёх endpoints 9995 identities, тот же эффект                                           |
| `auth-limiter-tests-before.json`                                      | Новые security assertions запускаются против прежнего boolean limiter API; failures сохранены                                                                             |
| `hardening-http-before.json`                                          | 24 cases: 19 PASS, 5 FAIL; proxy collapse, отсутствующая trust policy/validation, malformed cookie, отсутствующий email health endpoint                                   |
| Независимый compiled network fixture                                  | Два forwarded clients → `127.0.0.1`/`127.0.0.1`; malformed session GET csrf → 401                                                                                         |
| `phase-3-hardening-baseline/composition-reproduction.json`            | SMTP down → core `SERVICE_UNAVAILABLE`; pending DB sibling вызван дважды                                                                                                  |
| [004→005 SQL fixture](../../scripts/test-auth-database-hardening.mjs) | Реальный before/after PASS 26 сентября; session contention, recovery invalidation, historical MFA snapshot и три grammar differences подтверждены на 004 и закрыты на 005 |

Отсутствие defect также проверялось: revoked canonical session и tampered preauth восстанавливались через csrf/login на исходном коде; repeated request ID не давал authentication. Эти случаи прошли до production исправлений и не заявлены как устранённые vulnerabilities.

## Выполненные проверки изменённого кода

Первый успешный набор unit/HTTP/lint/typecheck/build выполнен 21 сентября. Финальные format/lint/typecheck/unit/HTTP/runtime/docs/Argon benchmark повторены 27 сентября, 15:04–15:05 UTC; все завершились exit 0, manifest — `phase-3-hardening-validation/final-results.json`. Compiled integration ранее выполнил сборку итоговых исходников. Изменения отчёта после запуска требуют отдельного format/docs прохода.

| Проверка                                   | Exit status         | Подтверждённый результат / artifact                                                                               |
| ------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm format`                              | 0                   | `phase-3-hardening-validation/format-final.log`; последующее обновление отчёта проверяется отдельно               |
| `pnpm lint`                                | 0                   | `lint-final.log`                                                                                                  |
| `pnpm typecheck`                           | 0                   | `typecheck-final.log`                                                                                             |
| `pnpm test:unit`                           | 0                   | 338 PASS, `test-unit-final.log`                                                                                   |
| `pnpm test:http`                           | 0                   | 40 PASS, `test-http-final.log`                                                                                    |
| `pnpm build`                               | 0                   | `build-retry.log`; финальная compiled сборка также выполнена внутри integration runner                            |
| Dedicated real-Redis suite                 | 0                   | 26 PASS, `auth-limiter-tests.json`                                                                                |
| HTTP reproduction/after suite              | 0 после исправления | 40 PASS, `hardening-http-after.json`; включены 27 auth + 13 bootstrap                                             |
| Selected config/lifecycle/DSN tests        | 0                   | 128 PASS, `hardening-config-after.json`; входят в unit suite, не суммируются повторно                             |
| Scoped HTTP/config ESLint                  | 0                   | Проверены собственные source/test файлы; не заменяет полный lint                                                  |
| SQL before/after fixture 004→005           | 0                   | `auth-database-hardening.json`, completed `2026-09-27T15:02:12.529Z`, PASS                                        |
| Первый DB suite на 005, 26 сентября        | 1                   | 175 cases: 172 passed, 3 failed; история исправлений ниже                                                         |
| Повтор PostgreSQL/Redis suite, 27 сентября | 0                   | `database-tests.json`: 175/175 PASS, включая 58 auth SQL cases                                                    |
| Compiled auth flow, 27 сентября            | 0                   | `auth-runtime.json`: 46 HTTP requests PASS; SMTP-down boot/recovery; shutdown 41 ms; total 9,149 s                |
| Outer database runner, 27 сентября         | 1 → 0               | Первый load failed на health cache expectation; исправленный повтор PASS, completed `2026-09-27T07:33:49.661Z`    |
| Targeted load, 27 сентября                 | 0                   | `auth-hardening-load.json`: 100 users, PASS за 37,574 s; пять cyclic enumeration rounds и timing review завершены |

Первичные промежуточные `format.log`/`lint.log` сохранены рядом с successful retry. PASS относится к конкретному успешно завершённому запуску, а не к каждому файлу с похожим именем.

Первый полный DB suite выявил две ошибки error classification и одно устаревшее ожидание test contract. Тесты `separates function-only auth, tenant runtime and migration roles` и `rejects a non-inheriting runtime role that can assume a privileged role` получили безопасный, но неверно классифицированный `DATABASE_FAILED` вместо `DATABASE_ROLE_UNSAFE`: новый string/regclass privilege lookup требовал schema USAGE у заведомо недопустимой роли. Lookup переведён на catalog OIDs. Тест `resend reset invalidates its predecessor and rejects expired reset tokens` ожидал прежнюю инвалидацию; новая модель правильно сохраняет первую ссылку. Тест обновлён на cooldown, сохранность predecessor, TTL 15 минут и отдельный expired-link rejection. Повтор 27 сентября, начатый `2026-09-27T07:29:57.098Z`, подтвердил 175/175 PASS, включая 58 auth SQL cases; три прежних failures остаются частью истории validation.

Ранний audit draft прошёл `pnpm docs:check` 27 сентября: 33 documents, 300 local links, 65 tables, 21 fenced blocks. Финальный отчёт проверен 28 сентября: exit 0, 33 documents, 305 local links, 69 tables, 21 fenced blocks. Это DOC LINT, не remote-link/diagram/runtime validation.

Outer runner после успешных SQL/compiled checks сначала остановился на `SMTP degraded` load stage: fixture ожидал немедленный 503 от email health, хотя предыдущий probe ещё находился в документированном one-second cache. Исправлен именно test expectation: сначала проверяются controlled 503 email operations с fresh SMTP probe, затем down health. Это не новый application defect; повтор полного `pnpm test:database` завершился PASS. Compiled flow отдельно подтвердил запуск при SMTP down, existing login/me/logout и recovery без restart; его status/response checks не доказывают идеальную timing indistinguishability.

## Performance и targeted load

Все следующие SQL/load показатели взяты из одного финального локального integration run 27 сентября. Отдельный CI run 28 сентября также PASS; его показатели не смешиваются с этой локальной выборкой. SQL artifact completed `2026-09-27T15:02:12.529Z`; load artifact completed `2026-09-27T15:03:35.731Z`. Это controlled loopback acceptance на Windows/Node 24.20.0/PostgreSQL 17.11, а не production throughput/SLO. Условия разных дней и host load различаются; нельзя выбирать лучшие percentiles из разных запусков.

### Redis cardinality

Reproduction использует 10 020 attempts, параллельные партии по 16. Baseline `auth-limiter-hardening-before.json`: один endpoint p50/p95/p99 2,133/3,872/5,883 ms, три endpoints 1,836/2,532/4,047 ms. Итоговый `auth-limiter-hardening.json`: соответственно 3,150/7,739/11,517 ms и 2,153/3,445/7,263 ms. Timings между разными запусками не являются контролируемым throughput comparison. Доказанное изменение — ограниченная cardinality и сохранённый admission другого IP.

| Redis scenario | До: identities / admitted | После: identities / admitted | Другой IP до → после |
| -------------- | ------------------------- | ---------------------------- | -------------------- |
| Один endpoint  | 9997 / 20                 | 20 / 20                      | deny → allow         |
| Три endpoints  | 9995 / 60                 | 60 / 60                      | deny → allow         |

### Session SQL: 004 → 005

[Fixture](../../scripts/test-auth-database-hardening.mjs) использует одного пользователя/сессию и одинаковый pool=3; latency включает ожидание пула. На 004 fresh authenticate ожидал удерживаемый User lock; на 005 завершился без этого ожидания. Это deterministic contention proof отдельно от percentile sampling.

| Concurrent authenticate | p50 ms до → после | p95 ms до → после | p99 ms до → после | UPDATE до → после | Приблизительный WAL bytes до → после | Sampled max lock waits до → после |
| ----------------------- | ----------------- | ----------------- | ----------------- | ----------------- | ------------------------------------ | --------------------------------- |
| 10                      | 34,180 → 8,032    | 59,763 → 10,233   | 59,763 → 10,233   | 10 → 0            | 2408 → 0                             | 2 → 0                             |
| 50                      | 137,715 → 19,034  | 270,465 → 29,453  | 280,626 → 30,676  | 50 → 0            | 12216 → 0                            | 2 → 0                             |
| 100                     | 256,105 → 43,823  | 476,564 → 70,606  | 496,183 → 72,654  | 100 → 0           | 24456 → 0                            | 2 → 0                             |

В обоих вариантах error count 0; max observed waitingRequests 10/50/100 при одном pool budget. Dead-tuple deltas до 10/21/6, после 0/0/0. WAL/dead tuples — приблизительные statistics; sampler может пропустить короткие lock waits. Измерение относится к fresh session path; due touch сохраняет необходимые security locks. Отсутствие User lock не означает отсутствия ожидания ограниченного connection pool.

### HTTP load и failure scenarios

[Targeted runner](../../scripts/test-auth-hardening.mjs) завершился PASS за 37,574 s: 100 пользователей и 100 активных sessions в начале. Таблица показывает весь измеренный workload, включая ожидаемые controlled refusals. `non-2xx` не означает unexpected application failure для attack/fault сценариев.

| Сценарий                                              | Samples      | p50 ms  | p95 ms  | p99 ms  | Ответы / non-2xx                        |
| ----------------------------------------------------- | ------------ | ------- | ------- | ------- | --------------------------------------- |
| 100 sessions authenticate                             | 100          | 70,26   | 148,10  | 171,78  | 100×200 / 0%                            |
| Mixed login/me/rotate, четыре HTTP запроса в sequence | 24 sequences | 690,35  | 949,37  | 956,05  | 24 успешные sequences / 0%              |
| Один пользователь, 50 parallel reads                  | 50           | 112,11  | 171,47  | 176,27  | 32×200, 18×503 / 36%                    |
| Rate-limited attack                                   | 100          | 21,97   | 228,44  | 265,73  | 20×401, 80×429 / 100% ожидаемых отказов |
| Argon login burst                                     | 20           | 53,25   | 1054,81 | 1063,11 | 10×200, 10×503 / 50%                    |
| SMTP down, authenticated reads                        | 20           | 41,21   | 79,36   | 84,46   | 20×200 / 0%                             |
| Redis +120 ms в каждом направлении                    | 10           | 278,54  | 635,22  | 635,22  | 10×200 / 0%                             |
| Redis timeout, fail closed                            | 10           | 1010,93 | 1013,45 | 1013,45 | 10×503 / 100% ожидаемых отказов         |

50-read burst подтвердил bounded service refusal, но не обслуживание всех 50 запросов: 18 получили 503. Burst tests требуют минимум один 200, поэтому полностью отказавший burst не мог дать PASS. Mixed percentiles относятся к четырёхзапросным sequences, а не к одному endpoint. Worker cleanup дожидается уже начатых requests даже при ошибке другого worker.

| Измеренная граница         | Результат                                                                  |
| -------------------------- | -------------------------------------------------------------------------- |
| Auth PostgreSQL pool       | max connections 3, busy 3, waiting 19; sampled lockWaiters 0               |
| Application runtime pool   | Отдельные пять соединений; queue/busy diagnostics этого пула не собирались |
| Argon2id                   | Work factor 64 MiB/t=3/p=1; peak running 2, queued 8                       |
| Прямой Argon overflow      | 22 submitted, 10 accepted, 12 rejected busy                                |
| Redis operations, весь run | 616 samples; p50/p95/p99 13,07/41,58/1003,61 ms; включает injected faults  |
| Redis operations с delay   | 10 samples; p50/p95/p99 249,42/621,31/621,31 ms                            |
| Event-loop lag             | p50 13,885; p95 21,135; p99 23,364; max 49,578 ms                          |
| RSS                        | peak 402202624 bytes; max RSS 392776 KiB, примерно 383,6 MiB               |
| SMTP degraded              | Core ready; три email operations controlled 503; recovery без restart      |
| Secret canaries            | `secretFreeLogs: true`                                                     |

### Account enumeration: измерение и review

Первый успешный load использовал три samples с последовательными группами states; его signup medians около 458 ms и 314 ms различались. Это были медианы групп, не один первый sample. Для устранения order/warm-up confounding повтор выполнен в пяти раундах с циклическим порядком account states. Latest artifact сохраняет все raw samples; status/response-length equality проверяется автоматически, timing interpretation — отдельный review.

| Account state | Login p50 ms | Resend p50 ms | Forgot-password p50 ms | Signup p50 ms | Signup raw range ms |
| ------------- | ------------ | ------------- | ---------------------- | ------------- | ------------------- |
| active        | 203,02       | 138,98        | 131,26                 | 328,64        | 290,41–348,16       |
| pending       | 200,66       | 135,09        | 133,81                 | 303,84        | 295,43–330,05       |
| suspended     | 201,86       | 128,04        | 131,69                 | 317,94        | 296,17–356,06       |
| MFA           | 209,35       | 134,19        | 139,41                 | 305,19        | 297,47–309,34       |
| unknown       | 192,03       | 140,10        | 132,20                 | 325,46        | 296,11–334,37       |

Для каждого state login с неправильным паролем вернул 401 и 123 response bytes; resend/forgot/signup — 202 и 21 bytes. После interleaving крупное устойчивое timing separation unknown/existing не воспроизвелось: raw ranges пересекаются, unknown signup median близка к active. Этот малый sample не доказывает network constant time и не исключает слабые статистические различия при большем количестве наблюдений. Вывод ограничен наблюдаемыми status/length, общей Argon/SMTP admission логикой и этими timings. Внешняя доставка SMTP и production network в measurement не входят.

## Security invariants и границы проверки

| Invariant                                                          | Подтверждённое evidence                                                        | Ограничение / последующая задача                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Tokens/passwords/SQL/DSN не раскрываются в HTTP/logs               | Unit/HTTP/compiled/load и Docker canaries PASS                                 | Canary tests проверяют заданные secret fixtures                                                     |
| Origin/CSRF, host-only Secure cookies, rotation, duplicate headers | 40 HTTP PASS; compiled auth и Docker flow PASS                                 | Production TLS/ingress configuration проверяется при deployment                                     |
| Proxy trust explicit, direct spoof ignored                         | Real-socket HTTP/config PASS; Docker/deployment validation PASS                | Фактический production proxy должен соответствовать documented allowlist                            |
| Redis fail closed, bounded state, no one-IP global cardinality DoS | 26 real-Redis PASS; mixed load/delay/timeout и Docker recovery PASS            | Распределённый abuse и capacity требуют production policy                                           |
| Reset/password change revoke sessions/epoch/LIVE                   | 005 SQL regression, compiled и Docker auth flow PASS                           | Будущие protected writes сохраняют transaction authorization contract                               |
| ADMIN/MFA, stale snapshot, concurrent transitions                  | SQL concurrency, 004→005 fixtures, compiled/load/Docker и clean PASS           | Полный TOTP verifier остаётся последующей фазой                                                     |
| ctp_api/ctp_auth/owner, FORCE RLS, safe SECURITY DEFINER           | Negative grant/temp-hijack, 175 SQL/Redis cases, integration/Docker/clean PASS | Privileged provisioning и IAM остаются deployment boundary                                          |
| Account enumeration и email normalization                          | Service/Node-SMTP/SQL corpus, compiled status/body checks PASS                 | Пять cyclic samples/state reviewed: gross oracle не воспроизвёлся; small-sample limitation остаётся |
| Argon concurrency/queue/shutdown                                   | Unit capacity, runtime, load и Docker shutdown PASS                            | Локально 2 active/8 queued, RSS ≈383,6 MiB; production sizing не подтверждён                        |
| Session/token retention                                            | Policy определена в findings                                                   | Production cleanup job не реализован; до production обязательный gate                               |

## GitHub CI — проверенный commit

[Run 36392668471](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/36392668471) проверил именно `20f25872394c9d71fefa98edffe2aa5b50a316d5`. Все три jobs завершились success: `Checks (ubuntu-24.04)`, `Checks (windows-2025)`, `Real services and Docker smoke`. Результаты ниже относятся к этому SHA реализации; отчёт о них добавлен отдельным документационным изменением.

На Ubuntu и Windows выполнены pinned/frozen install, `db:validate`, build, `benchmark:auth`, `format:check`, `docs:check`, lint, typecheck, unit, HTTP, runtime, clean и `audit:dependencies`; проверена неизменность lockfile. Linux Docker job повторил `test:integration` и `test:smoke`. Workflow не запускает отдельный alias `test:database`: полный database runner входит в integration; отдельный `test:auth-hardening` alias также не заявляется. Полный JSON vulnerability audit выполнен отдельно локально 28 сентября; CI `audit:dependencies` запускает `pnpm audit --audit-level=high` и также завершился успешно.

Downloaded artifacts: `test-results/ci-hardening-36392668471/bootstrap-ubuntu-24.04`, `bootstrap-windows-2025`, `bootstrap-docker`. В Docker artifact `database.json` — 175 tests PASS, fresh/upgrade/non-BYPASS/repeat/reset/runtime/hardening PASS; `integration.json` completed `2026-09-28T07:42:34.897Z`. `auth-hardening-load.json` PASS: 100 users и 100 active sessions, completed `2026-09-28T07:42:32.562Z`, secret canaries PASS. Результаты разных платформ не суммируются как разные tests.

| Docker smoke evidence   | Результат Linux CI                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `smoke.json`            | PASS, completed `2026-09-28T07:44:03.306Z`                                                                          |
| Core boot при SMTP down | `smtpBootDownCoreAvailable: true`; core ready, email health 503                                                     |
| SMTP recovery           | `smtpRecoveryWithoutRestart: true`                                                                                  |
| Auth flow               | 46 requests; signup/verify, CSRF/origin, ownership, rotation/revocation, reset/change, enumeration, rate limit PASS |
| PostgreSQL recovery     | Сама dependency ready за 5692 ms, затем API ready за 2 ms                                                           |
| Redis recovery          | Сама dependency ready за 5696 ms, затем API ready за 1 ms                                                           |
| SIGTERM                 | Shutdown 301 ms, completed shutdown log                                                                             |
| Container boundaries    | Non-root image, runtime secret canaries и image configuration checks PASS                                           |

## Финальный validation — PASS

| Команда                    | Локальный результат; для smoke — Linux CI                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm format`              | 0, `format-final.log`; обновления отчёта проверяются отдельно перед публикацией                                                                        |
| `pnpm lint`                | 0, `lint-final.log`                                                                                                                                    |
| `pnpm typecheck`           | 0, `typecheck-final.log`                                                                                                                               |
| `pnpm test:unit`           | 0, 338 PASS, `test-unit-final.log`                                                                                                                     |
| `pnpm test:http`           | 0, 40 PASS, `test-http-final.log`                                                                                                                      |
| `pnpm test:database`       | 0: 175 SQL/Redis, compiled flow, load, fresh/upgrade/non-BYPASS/repeat/reset PASS; последующий integration rerun также 0                               |
| `pnpm test:runtime`        | 0, `test-runtime-final.log`                                                                                                                            |
| `pnpm test:integration`    | 0, final retry `2026-09-27T15:01:06.266Z`–`15:03:45.701Z`: 175 SQL/Redis + 3 services + compiled/load PASS                                             |
| `pnpm test:smoke`          | Локально два host failures; Linux CI exit 0, `smoke.json` PASS `2026-09-28T07:44:03.306Z`; SMTP-down boot/recovery проверены                           |
| `pnpm test:clean`          | 0, completed `2026-09-27T15:12:13Z`: fresh offline install, build, production API/database deploy; native Argon/WASM и неизменность lockfile проверены |
| `pnpm docs:check`          | 0, `docs-check-final.log`; повторить после последнего обновления отчёта                                                                                |
| `pnpm audit --json`        | 0, `phase-3-hardening-validation/audit-20260928.json`: 0 vulnerabilities / 404 dependencies, 28 сентября                                               |
| `pnpm test:auth-hardening` | SQL benchmark и targeted load PASS внутри final integration; отдельный alias не запускался и не заявлен                                                |
| `pnpm benchmark:auth`      | 0, `benchmark-auth-final.log`: hash p50/p95 148/181 ms; verify 156/164 ms; две parallel operations 169 ms                                              |

Итоговые локальные tests: **556** = 338 unit + 40 HTTP + 175 PostgreSQL/Redis + 3 service tests. Другие acceptance сценарии и повторные запуски не увеличивают этот счётчик.

Оба локальных Docker smoke остановились во время image build с BuildKit RPC EOF. Windows System Event 2004 (`Resource-Exhaustion-Detector`) 27 сентября в 18:06:55 и 18:08:48 по местному времени зафиксировал исчерпание commit memory; `vmmemWSL` занимал приблизительно 4,37/4,77 GB перед остановкой VM. Это подтверждённый host prerequisite failure, а не успешный smoke и не доказанный application defect. Остановлен только task-owned Docker после проверки отсутствия работающих контейнеров, затем локальный clean PASS. Изменения pagefile/WSL/system limits и остановка чужих приложений не выполнялись. Финальный canonical Docker smoke выполнен в разрешённом GitHub Linux CI и завершился PASS. Проверены core boot без mail-sink, email health 503 и recovery после запуска SMTP. Два локальных host failures остаются частью истории validation.

## Изменённые файлы

Снимок `git status --porcelain=v1 --untracked-files=all` после реализации: 53 файлов, включая новые документы и migration 005. Generated reports/dist и другие ignored artifacts в этот список не входят. Опубликованные migrations 001–004 и `pnpm-lock.yaml` не изменены.

- `.env.example`
- `README.md`
- `apps/api/src/app.ts`
- `apps/api/src/auth-routes.ts`
- `apps/api/src/health.ts`
- `apps/api/src/server.ts`
- `apps/api/test/auth.http.integration.test.ts`
- `apps/api/test/health.unit.test.ts`
- `apps/api/test/http.integration.test.ts`
- `apps/api/test/lifecycle.unit.test.ts`
- `docs/deployment.md`
- `docs/phase-3/auth-api.md`
- `docs/phase-3/database-security.md`
- `docs/phase-3/operations.md`
- `docs/phase-3/requirements.md`
- `docs/phase-3/verification.md`
- `infra/compose.dev.yml`
- `package.json`
- `packages/auth/src/mail.ts`
- `packages/auth/src/password.ts`
- `packages/auth/src/rate-limit.ts`
- `packages/auth/src/service.ts`
- `packages/auth/test/mail.unit.test.ts`
- `packages/auth/test/password-capacity.unit.test.ts`
- `packages/auth/test/rate-limit.integration.test.ts`
- `packages/auth/test/rate-limit.unit.test.ts`
- `packages/auth/test/service.unit.test.ts`
- `packages/config/src/index.ts`
- `packages/config/test/auth-config.unit.test.ts`
- `packages/config/test/config.unit.test.ts`
- `packages/database/src/auth-database.ts`
- `packages/database/src/index.ts`
- `packages/database/test/auth.integration.test.ts`
- `packages/database/test/dsn-contract.unit.test.ts`
- `scripts/mail-sink.mjs`
- `scripts/test-auth-runtime.mjs`
- `scripts/test-database.mjs`
- `scripts/test-smoke.mjs`
- `apps/api/src/client-ip.ts` — новый
- `docs/phase-3-hardening/findings.md` — новый
- `docs/phase-3-hardening/requirements.md` — новый
- `docs/phase-3-hardening/verification.md` — новый
- `packages/auth/src/mailbox.ts` — новый
- `packages/auth/test/mailbox.unit.test.ts` — новый
- `packages/auth/test/rate-limit-hardening.integration.test.ts` — новый
- `packages/database/prisma/migrations/202609200001_auth_hardening/migration.sql` — новый
- `packages/database/src/auth-role-boundary.ts` — новый
- `scripts/auth-enumeration.mjs` — новый
- `scripts/auth-http-fixture.mjs` — новый
- `scripts/test-auth-database-hardening.mjs` — новый
- `scripts/test-auth-hardening.mjs` — новый
- `scripts/test-auth-limiter.mjs` — новый
- `tests/fixtures/auth-email.ts` — новый

## Remaining risks и gate

Реальные остаточные production задачи: seven-day token/30-day session retention job и отдельная durable audit policy; надёжная доставка email после crash; проверенный внешний SMTP и deployment proxy ingress; capacity/abuse policy для распределённых IP и scoped Redis saturation. Полный TOTP/KMS verifier и frontend остаются ранее оговорёнными последующими фазами; ADMIN/MFA password-only fallback не добавлен.

Проверка hardening завершена для tested commit `20f25872394c9d71fefa98edffe2aa5b50a316d5`: локальные проверки и все три CI jobs PASS. Docker smoke подтвердил запуск API без mail-sink и последующий recovery; local host failures сохранены в отчёте. Integration/load и enumeration review завершены, dependency audit чистый, hashes 001–004 и lockfile неизменны. Gate для перехода к PHASE 4 открыт; перечисленные production prerequisites сохраняются и не объявляются реализованными.

**READY FOR PHASE 4**
