# PHASE 5 — Проверка Binance Adapter

Статус: **IN PROGRESS — локальный regression PASS, полный CI ожидается**. PHASE 6 не начата. LIVE trading выключен; реальных private account requests и trading mutations нет. Scope и ограничения: [requirements](requirements.md), [contracts](contracts.md), [dependencies](dependencies.md).

Baseline: `09279dcd117b4a7bb1d667b1d660986551b169a5`, clean main до реализации. Прочитаны актуальные PHASE 0–4 docs, исходный roadmap и security/database/execution contracts. До изменений выполнены static/unit/HTTP/build/runtime/docs/clean/audit и все три job [повторного baseline CI](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/36766506108). Старые acceptance PHASE 0–4 не заменяются результатами нового кода.

## Реализованный результат

`@ctp/exchange-binance` — самостоятельный private ESM package с real Node HTTP(S)/WS, strict server profiles, bounded async lifecycle, public metadata/REST/streams и private auth/balances/orders/positions. Production entrypoint предоставляет factory и server port contracts; raw IO, signer и test assembly не экспортируются. Пакет не подключён к API, финансовых writers/новых migrations нет.

Factory использует существующие 33 операции Exchange Core. Поддержка каждой ограничена фактически реализованным протоколом и свежим capability evidence. Algo, quote-budget, HEDGE, COIN-M, dated futures, amendment/position-mode mutation, synthetic 30s и неподтверждённый USD-M TESTNET private WS явно UNSUPPORTED. Эти ограничения не маскируются успешными parser fixtures. Полный recovery/Risk/portfolio/market-data engine остаётся в соответствующих последующих фазах.

## Reproduction и regression

Подтверждённые проблемы завершённых фаз исправлены минимально после RED tests; новый adapter дополнен contract tests до исправления выявленных нарушений.

| Проблема                                                | Воспроизведение до исправления                                                                                           | Итоговый контракт и regression                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Два trigger в createAlgoOrder                           | `phase5-algo-before.json`                                                                                                | 22 tests: один outer trigger, MARKET/LIMIT child с null trigger; nested STOP отвергается до authorizer/IO                                |
| Spot depth без native exchangeTime                      | `phase5-book-time-before.json`                                                                                           | только orderBook timestamp nullable; trade/fill timestamp остаётся обязательным                                                          |
| USD-M wallet не сообщает Spot free/locked               | `phase5-balance-before.json`                                                                                             | nullable отсутствующие компоненты; wallet/available берутся из native полей, locked не вычисляется из PnL                                |
| HTTP/WS hang, aborted/hung server ports                 | `phase5-io-before.json`, `phase5-client-before.json`, `phase5-auth-bound-before.json`                                    | уничтожение sockets, finite promise settling, late completion без dispatch, release всех 16 Core slots                                   |
| Native child ID / MARKET_LOT_SIZE                       | `phase5-private-child-identity-before.json`, `phase5-private-market-filters-before.json`                                 | generic algo UNSUPPORTED; MARKET использует отдельный step; ambiguous outcome UNKNOWN без POST retry                                     |
| Metadata поменялась во время await admission            | `phase5-private-metadata-race-before.json`                                                                               | повторная проверка record/admission непосредственно перед dispatch; immutable account testConnection                                     |
| Старый timestamp после rate/WS queue                    | `phase5-private-signature-before.json`, `phase5-private-ws-signature-before.json`                                        | REST/WS signature готовится после соответствующих admission waits                                                                        |
| Неверная private ACK/rate классификация                 | `phase5-private-ack-classification-before.json`, `phase5-private-ws-rates-before.json`                                   | ACK ошибки и counters/RetryAfter проходят typed error/rate observer boundary                                                             |
| Свежий другой asset скрывал stale изменённый balance    | `phase5-private-balance-proof-before.json`                                                                               | каждый changed asset проверяется по своему native updateTime; устаревший snapshot завершает stream GAP                                   |
| A→B→A metadata и concurrent cursor при одинаковом clock | `phase5-metadata-reversion-before.json`, `phase5-metadata-concurrency-before.json`, `phase5-public-registry-before.json` | отдельные observation versions/lease IDs; cursor не смешивает новую страницу; старый registry record не восстанавливает удалённый symbol |
| Fastify HTTP/2 trailer crash                            | `phase5-fastify-trailer-before.json` — ECONNRESET реального child process                                                | Fastify 5.12.5; child обслуживает два real HTTP/2 trailer responses без crash                                                            |

RED artifacts — диагностика прежнего поведения, не acceptance нового кода. Все перечисленные fixes покрыты окончательным unit/HTTP suite. Exploratory stubs для ещё не реализованных модулей не объявляются defects завершённой базы. Локальные artifacts исключены из Git.

## Локальная проверка 2 октября 2026

Windows, Node 24.20.0, pnpm 11.25.0. Результаты нового source проверены отдельно от baseline.

`pnpm format:check` — PASS после форматирования нового manifest; `pnpm docs:check` — PASS: 41 документ, 390 local links. Clean-deployment lockfile SHA-256: `d30337fc28949ff05ee8704508dd625122e1eb0fcdd9bce5ccb3439e0148bdc1`. Runtime report: 64 concurrent readiness, максимум 2 dependency sockets, shutdown 145 мс; реальный Linux SIGTERM отдельно проверяется CI smoke.

| Команда / проверка                      | Фактический результат                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm lint`, `pnpm typecheck`           | PASS, прямые node entrypoints дали exit 0                                                                                      |
| `pnpm test:unit`                        | PASS: 53 files, **1678 tests = 806 Exchange Core + 522 Binance + 350 прежних**; окончательный direct Vitest run exit 0         |
| `pnpm test:http`                        | PASS: **41 tests**, включая новый real HTTP/2 security regression                                                              |
| `pnpm build`, `pnpm db:validate`        | PASS: все 7 workspace packages/apps, Prisma schema valid                                                                       |
| `pnpm test:runtime`                     | PASS: compiled API lifecycle, real bounded dependencies, concurrency/shutdown/log checks                                       |
| `pnpm test:clean`                       | PASS: fresh source, frozen install/build, supply-chain policy и isolated production imports API/database/Exchange Core/Binance |
| `pnpm audit --json`                     | PASS: **0 vulnerabilities**, все severity нулевые                                                                              |
| Diff migrations / schema предыдущих фаз | PASS: опубликованные migrations 001–005 и Prisma schema не изменены                                                            |

В unit suite есть actual loopback HTTP/WS integration: hung headers/body/handshake, abort и timeout, oversized/malformed messages, forced close и отсутствие late DATA. Production factory проверяется через loopback remapping только во внутреннем test assembly; пользовательский URL в factory запрещён. Real HTTP HMAC/createOrder, lost ACK/-1007 → UNKNOWN → clientOrderId FOUND выполняются без второго POST. Отдельные тесты освобождают все 16 Core/network slots и подтверждают закрытие серверных sockets после hung transport.

Local Docker integration этого source не заявляется: canonical full real PostgreSQL/Redis/SMTP и API-container acceptance выполняется Linux CI. После CI здесь будут сохранены точный source SHA, run URL, job conclusions и counts из скачанных artifacts. READY gate до этого отсутствует.

## Внешний read-only probe

После окончательной build запущен `pnpm probe:binance`. Sanitized artifact `test-results/phase5-binance-public-probe.json`: 2026-10-02 13:04:33–13:05:08 UTC, **PARTIAL**, exit 2. На каждом из пяти server profiles выполнены getServerTime/getSymbols/getTicker/getOrderBook/getHistoricalCandles: **25/25 REST operations PASS, HTTP 200**. Universe только BTCUSDT, максимум 8 reservations/40 weight/одна WS attempt на profile, общий window 10 секунд. Секретов/account binding нет.

| Profile       | REST     | Native ticker WS                         |
| ------------- | -------- | ---------------------------------------- |
| Spot LIVE     | 5/5 PASS | PASS                                     |
| Spot TESTNET  | 5/5 PASS | PASS                                     |
| Spot DEMO     | 5/5 PASS | PASS                                     |
| USD-M LIVE    | 5/5 PASS | PASS                                     |
| USD-M TESTNET | 5/5 PASS | NOT_RUN: WS_ABORTED при bounded deadline |

Это подтверждает публичную совместимость указанной сборки и доступность в момент probe, а не постоянный SLA. USD-M TESTNET external WS evidence отсутствует; fixture/loopback protocol tests проходят. Повторов, redirects, alternate hosts и региональных обходов не выполнялось. Private authenticated REST/WS, real TESTNET/DEMO create/cancel/leverage и LIVE mutations: **NOT RUN**; account credentials/acceptance scope не предоставлены. Public LIVE reads не включают LIVE trading. Ранний probe 1 октября был PARTIAL с дополнительными WS deadlines; итоговая таблица относится только к последней сборке.

## Согласование PHASE 0–5

Scope/order/hash/authorization guards Exchange Core сохранены; валидный MARKET/LIMIT algo command не меняет normalized hash shape. Standalone STOP остаётся отдельным контрактом. Отсутствующая exchange metadata не превращается в выдуманное значение. BASE/decimal/storage bounds совпадают с PHASE 2; balance nullable поля обязательны в DTO даже когда значение null. Published database security grants, ownership/concurrency controls, auth code и API composition не изменены.

Единственный runtime dependency patch прежнего API — подтверждённый Fastify security defect, с reproduction до обновления. Supply-chain minimumReleaseAge=1440, exact versions, frozen lock и опубликованные DB migrations сохранены. Полный CI проверит auth/email/recovery flows и real service/Docker shutdown вместе с новым adapter.

## Изменённые файлы

- Новый `packages/exchange-binance/`: package/build config, `src/adapter.ts`, `auth.ts`, `client.ts`, `index.ts`, `io.ts`, `ports.ts`, `profiles.ts`, public/private data/transport/streams и protocol/lifecycle regression tests.
- Минимальные confirmed-defect changes в `packages/exchange-core/src/domain.ts`, `operations.ts`; три новых contract test files.
- Fastify exact patch в `apps/api/package.json`; HTTP/2 regression и disposable fixture в `apps/api/test/`.
- Корневые package/lock/tsconfig/Vitest aliases; clean-deployment script, manual public probe, README и phase contracts/docs.

## Acceptance boundary

READY FOR PHASE 6 разрешён только после PASS всех трёх full CI jobs, включая real services/Docker. Gate относится к реализованному Binance protocol package с указанными UNSUPPORTED/NOT RUN границами. Он не разрешает real trading, не заменяет server distributed limiter/durable identity/authorization/admission ports и не заявляет production readiness либо нагрузочный профиль 300 instruments. PHASE 6 до gate не начинается.
