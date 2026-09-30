# PHASE 4 — Проверка Exchange Core

Дата: **2026-09-30**. Baseline: `cd940304cb730d054fb41429562975c9033fed95`, завершённый [аудит PHASE 0–3](../audit-phases-0-3.md). Gate: **IN PROGRESS** — общие проверки и CI новой реализации ещё не завершены. PHASE 5 не начата.

## Выполненная реализация

Создан `@ctp/exchange-core`: точные decimal operations, normalized DTO/runtime schemas, полный profile/account/capability scope, типизированные ошибки, instrument registry port/reference, storage/time boundaries, HMAC pagination, bounded streams и factory с 33 операциями плюс disconnect. [Требования](requirements.md) и [точные контракты](contracts.md) описывают семантику и пределы ответственности.

Test adapter использует только локальные искусственные fixtures и управляемые transport callbacks. В production composition root он не зарегистрирован; clean deployment дополнен проверкой compiled package и отсутствия tests/testing export. Протоколы Binance/Bybit/OKX/HTX, реальные calls, API routes и финансовые writers не добавлены.

## Review и регрессии

| Проверка            | Результат реализации                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decimal/rules       | Точные arbitrary steps, bounded overflow, BASE/CONTRACTS conversion, quote budget, stale versions; unknown average не становится нулевой ценой                                                                                        |
| Registry history    | Воспроизведены четыре отказа: mutable capacity/options, повтор старого rules ID, старого metadata ID, вытеснение истории при переполнении. После исправления snapshot config и bounded non-evicting history все четыре tests проходят |
| Исключения          | Воспроизведён выход исключения из getter входного error. Sanitizer теперь возвращает статический UNAVAILABLE без transport details                                                                                                    |
| Algo trigger        | Отдельный trigger.price теперь проверяется по tick/min/max, как и цена внутренней команды                                                                                                                                             |
| History/open orders | Ответ проверяется по согласованному `[from,to)` и полю времени конкретного метода; terminal/UNKNOWN не принимаются в getOpenOrders                                                                                                    |
| Async lifecycle     | Повторный preflight после authorization; abort upstream при terminal; late-handshake close и удержание slot до settling request/source close                                                                                          |
| Pagination          | Encoded public cursor проходит собственную output schema; raw cursor имеет отдельный меньший bound; scope/filters и expiry защищены HMAC                                                                                              |
| Между фазами        | Mode/market/expiry/unknown average и decimal категории сверены с PHASE 2; полный persistence mapper не заявляется                                                                                                                     |

Локальные RED artifacts registry/errors сохранены в `test-results/phase4-registry-history-before.json` и `test-results/phase4-errors-before.json`. Decimal storage mismatch воспроизведён в `test-results/phase4-storage-decimal-before.json`: 7 failures из 27; после изменения aggregate balances/PnL и minNotional все 27 прошли, связанный набор — 278/278 PASS. Эти RED artifacts являются диагностикой до исправления, не доказательством итогового PASS. Ранние exploratory RED domain tests выводились в консоль и отдельным артефактом не сохранялись.

## Приёмочные проверки

Локально на Windows / Node 24.20.0 / pnpm 11.25.0 выполнены:

| Команда / проверка                                                    | Результат                                                                                                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm docs:check` | PASS после исправления literal capability types; 37 документов, 372 local links                                                          |
| `pnpm test:unit`                                                      | PASS: 1130 tests, включая 780 Exchange Core и прежние 350                                                                                |
| `pnpm test:http`                                                      | PASS: 40 tests, после dependency patches                                                                                                 |
| `pnpm build`                                                          | PASS: все 6 workspace packages/apps                                                                                                      |
| `pnpm test:runtime`                                                   | PASS: 64 concurrent readiness, максимум 2 dependency sockets, shutdown 37 ms; Windows test IPC, реальный Linux SIGTERM проверяется smoke |
| `pnpm audit --json`                                                   | PASS: 0 vulnerabilities после точечных security patches                                                                                  |
| Diff опубликованных migrations против baseline                        | PASS: изменений нет                                                                                                                      |

`pnpm test:clean` — PASS: fresh source copy, frozen offline install/build, policy verification и isolated production deployments API/database/exchange-core. Native Argon2id и PostgreSQL WASM загружаются без dev tools; Exchange Core импортируется из dist, tests/src/testing export отсутствуют. Lockfile SHA-256: `70c333045e4aab1e118b614fcc7910d718ece85b986748d651db048503704763`.

CI integration/smoke ещё не завершены. Итоговый commit/CI будут зафиксированы после их завершения; до этого gate IN PROGRESS. Unit counts не суммируются повторно между scoped/full runs или платформами.

## Dependency audit

Полный audit 30 сентября сначала обнаружил 6 findings (4 moderate, 2 high) в существующих `fast-uri` и `brace-expansion`; новая decimal.js не была источником findings. Выполнены минимальные совместимые patch updates: fast-uri 3.1.7 → 3.1.8, 4.1.4 → 4.1.5, brace-expansion 5.0.9 → 5.0.12. Exact parent selectors находятся в `pnpm-workspace.yaml`; `.pnpmfile.mjs`, direct dependency versions и `minimumReleaseAge: 1440` сохранены. Релизы опубликованы 14–15 сентября, исключения release-age не потребовались.

Основания: upstream [fast-uri 3.1.8](https://github.com/fastify/fast-uri/releases/tag/v3.1.8), [fast-uri 4.1.5](https://github.com/fastify/fast-uri/releases/tag/v4.1.5), [brace-expansion advisory](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-q2hr-2g5m-vwhr). До/после: `test-results/phase4-dependency-audit-before.json` и `test-results/phase4-dependency-audit.json`. Итоговый audit содержит пустые advisories и нули всех severity; это результат на дату проверки, не гарантия отсутствия будущих advisories.

## Изменённые файлы

- `packages/exchange-core/package.json`, `tsconfig.build.json`.
- `packages/exchange-core/src/`: `index.ts`, `decimal.ts`, `scope.ts`, `domain.ts`, `errors.ts`, `registry.ts`, `operations.ts`, `adapter.ts`, `subscription.ts`, `cursor.ts`, `time.ts`, `storage-boundary.ts`.
- `packages/exchange-core/test/`: `adapter.unit.test.ts`, `cursor.unit.test.ts`, `decimal.unit.test.ts`, `domain.unit.test.ts`, `errors.unit.test.ts`, `registry.unit.test.ts`, `registry-history.unit.test.ts`, `scope.unit.test.ts`, `storage-boundary.unit.test.ts`, `storage-decimal-alignment.unit.test.ts`, `subscription.unit.test.ts`, `time.unit.test.ts`; `fixtures/adapter.ts`, `fixtures/domain.ts`.
- Корневые `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `vitest.shared.ts`; `scripts/test-clean-install.mjs`.
- `README.md`, `docs/exchange-adapters.md`, три документа в `docs/phase-4/`.

Опубликованные migrations PHASE 2/3, auth implementation и API behavior не изменяются. Общие regression suites повторяются для проверки отсутствия повреждения базы проекта.

## Ограничения и следующий этап

Результат относится к общему контракту, а не к поддержке конкретных бирж или готовности к торговле. Нет distributed limiter, durable authorizer/dispatch dedup, refresh/persistence registry, full Prisma mapper, Risk valuation, order recovery/reconciliation, ledger и биржевых sequence/checksum/reconnect. Permissive test authorization не заменяет security boundary. LIVE mutations локально выключены; реальные TESTNET/DEMO mutations также не выполнялись.

После завершения gate следующий этап — PHASE 5 Binance по исходному плану: public REST/instruments/WS, затем private contracts и отдельные environment profiles. Требуются актуальная официальная schema и protocol fixtures; PHASE 4 не доказывает exchange compatibility. Нагрузочный профиль 300 инструментов и production readiness остаются отдельными этапами.
