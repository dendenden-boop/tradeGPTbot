# Risk Engine

PHASE 12 принята: **READY FOR PHASE 13**. Production PostgreSQL coordinator, atomic approval/reservation, Portfolio commitment/resolution bridge, current-state final dispatch и durable native AMEND/CANCEL lifecycle реализованы и приняты вместе. Accepted documentation main **754c969dcbe9882417f8ff893b4c2fb96b1c5c3e** passed [CI 37929257903](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37929257903) and [CodeQL 37929257839](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37929257839); the runtime is identical to accepted main 296972e7a428bfcb60227c84434ab51debd519aa. Artifacts verified 2026-10-09T12:34:14.448Z: 3033 unit / 41 HTTP per OS, 666 native PostgreSQL plus populated upgrade, owner repeats 14/95, eleven clean deployments per OS, dependency audit zero and no open CodeQL findings. Docker authenticated smoke made 46 requests; shutdown was 285ms.

LIVE disabled. Native AMEND ограничен Binance Spot TESTNET ordinary standalone LIMIT/GTC quantity decrease при неизменной цене; остальные profiles — UNSUPPORTED. Полный conservative principal/fee/UNKNOWN hold сохраняется, positive native credit disabled. Реальные private exchange tests и production soak не заявлены. PHASE 13 / Paper Engine в работе: calculator и отдельный configuration port не дают финансовой authority. Изолированный [initial funding](phase-13/funding.md) создаёт один PAPER_SEED в существующем ledger; это не RiskGrant и не разрешение dispatch. Certified PAPER Risk gateway ещё не принят, gate **NOT READY FOR PHASE 14**. [Paper contracts](phase-13/contracts.md), [Paper verification](phase-13/verification.md), [текущие Risk контракты](phase-12/contracts.md), [verification](phase-12/verification.md) и [ограничения](phase-12/completion.md).

Read-only [initial PAPER Portfolio source](phase-13/initial-portfolio.md) принят в source/PR scope **0b7e4ec5…** полным CI: только pristine funded account, `connectionId: null`, ноль новых postings и отказ при любой последующей activity. Это не certified RiskSnapshot и не bypass production admission. Full PAPER reservation/hold/dispatch lifecycle ещё не принят; final documentation-head/main evidence отдельно фиксируется в [Paper verification](phase-13/verification.md).

Этот документ сохраняет целевой Risk contract PHASE 0–22. Реализованные порты: createPostgresRiskSnapshotStore, createRiskSnapshotCoordinator и createPostgresOrderRiskPort; reference/test stores не являются production authority. EVALUATED — результат pure evaluator, а не durable RiskGrant. Production approve принимает только TESTNET/DEMO; наличие PAPER/LIVE policy rows не включает эти dispatch modes. HTTP trading, Strategy/TWAP/rebalance/synthetic/Paper callers относятся к будущим фазам и обязаны использовать тот же gateway.

Текущий evaluator требует exact NET position-mode evidence и отвергает HEDGE. Native quoteAsset prices, currency-qualified liquidity и доказанный FX без implicit stablecoin parity сохраняются; клиентский snapshot не становится trusted source.

## Интерфейс и входные данные

Концептуальная операция `evaluateAndReserve(intent, trustedContext)` реализована production-портом `createPostgresOrderRiskPort().approve()` и fixed SQL prepare/persist в одной bounded транзакции; это не имя отдельного публичного export. Pure evaluator получает immutable `RiskSnapshot` и возвращает EVALUATED либо REJECTED без transport authority. После known COMMIT approve возвращает durable grant с decisionId, reservationId, permissionEpoch и expiresAt; exact command/policy/state/rule scope сохраняется в immutable history. Перед transport start private SQL validate_dispatch повторно проверяет current state в permit transaction. Старый grant не является бессрочным разрешением; reject/uncertain COMMIT не возвращает grant.

Intent содержит явные units и классификацию `INCREASE|REDUCE|CANCEL|AMEND`. Классификацию определяет сервер по фактическому effect, не пользовательскому флагу. Изменение leverage, отмена protective stop или расширяющий amendment может увеличивать риск. Разрешение close не равно разрешению открыть обратную позицию.

RiskSnapshot включает reconciled balances/positions, все pending orders, UNKNOWN attempts, reservations, fees/funding, доступность collateral, prices с freshness, position/margin mode, metadata/rules, pause epochs и health обязательных систем. Ошибка/отсутствие значения не превращается в ноль. Цены всех валют для portfolio valuation должны иметь известный источник и возраст.

## Порядок проверок

| Группа               | Правила                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Идентичность и режим | Auth/ownership, tenant/account status, immutable mode, live grant, credential/version, destination profile, idempotency/signal duplicate |
| Инструмент           | Active/tradable, supported capability/type/units, актуальные tick/step/limits, price bands, contract size, settlement/expiry             |
| Состояние системы    | DB/limiter readiness, exchange health, private-stream freshness, reconciliation state, clock drift, market freshness, price deviation    |
| Баланс и ликвидность | Available funds/collateral, reserved funds, fee/slippage reserve, minimum free balance, spread/depth/liquidity policy                    |
| Лимиты заявки        | max order notional, min/max qty/notional, size after rounding, max order frequency, open orders count                                    |
| Совокупный риск      | per instrument/asset/account/user exposure, concurrent positions, portfolio hard limits, max leverage, pending+unknown exposure          |
| Потери               | Daily realized loss, daily total loss, adjusted equity drawdown, per strategy loss allocation                                            |
| Управление           | Strategy/user/connection/global pause, circuit state, policy version и истечение decision                                                |

Platform hard limits ограничивают пользовательскую политику: для максимума берётся меньшее, для обязательного минимума защиты — большее; conflicting ranges дают validation error, а не silent fallback. Пользователь не может снять platform pause или расширить hard limit через API.

Safe defaults: PAPER, Spot без leverage, нет implicit borrowing, LIVE disabled до настроенной политики и явного разрешения. Для paper tutorial допустим технический preset виртуального счёта, но его лимиты не копируются в LIVE. Конкретные live суммы/проценты не заданы пользователем: конфигурация обязательна, отсутствие означает отказ запуска, а не произвольный лимит.

## Decimal, rounding и exposure

Money arithmetic — Decimal с ограниченным input scale/range и достаточной промежуточной precision. Quantity округляется вниз к допустимому step; если станет zero/below minimum — reject. Цена округляется в безопасном для инструкции направлении: buy limit не выше согласованного максимума, sell limit не ниже согласованного минимума. Trigger/SL не округляются так, чтобы незаметно ослабить защиту; предложить валидное значение и повторное подтверждение при изменении семантики. После нормализации повторяются min/max/notional и risk checks; итоговый hash соответствует отправляемым байтам/semantics.

Для Spot резерв buy = worst-case cost + fee/slippage allowance, sell = base quantity плюс возможная base-denominated fee. Quote-budget buy моделируется именно как budget. Для linear derivatives notional рассчитывается через подтверждённую contract specification; inverse — отдельная функция. Нельзя использовать одну формулу PnL для обоих типов. Fee asset, rebates и funding хранятся отдельно; conversion в reporting currency сохраняет rate/time/provenance.

Exposure считает существующие позиции плюс максимальный возможный рост от открытых и неопределённых ордеров. Linked OCO нельзя автоматически net-off без подтверждённой atomicity. Не учитывать reservation второй раз, когда она уже представлена принятым order: сохраняется связь intent→reservation→order, amount переносится между состояниями. После partial fill риск делится на позицию и оставшийся order; количество/free balance не освобождается по одному cancel ACK.

Daily interval — UTC. Realized net включает realized trading PnL, fees и funding с явной учётной политикой; daily total loss — снижение equity, очищенное от net deposits/withdrawals/transfers и внутренних перемещений, без повторного вычета fees. Platform не делает withdrawals, но внешние movements счёта должна учитывать. High-watermark корректируется на внешние flows. При неизвестной valuation или переходе дня baseline не сбрасывается в пользу открытия риска — требуется reconstruction. Формулы и fixtures приняты в PHASE 12; UTC journal/checkpoint и external-flow reconstruction сохраняются при restart.

## Атомарное резервирование

Реализованный policy source PHASE 12: server-only createPostgresPolicies хранит immutable platform/user limits revisions и monotonic heads отдельно для PAPER/TESTNET/DEMO/LIVE. Permanent event replay/CAS переживает restart; отсутствие обеих policies или несовпадение valuationAsset закрывает current read. Policy publisher работает под отдельными SQL roles без финансовых writes; direct execution grant и смешанная Portfolio/controller роль не проходят SQL guard. Replacement участвует в GLOBAL → tenant ordering. Это источник current policy versions для принятых atomic approve и final dispatch checks. Сам policy read не выдаёт RiskGrant; grant создаётся только production admission после проверки полного certified state.

Две стратегии с доступными 100 USDT не должны одновременно получить независимые approvals по 80. Реализация использует bounded READ COMMITTED с GLOBAL shared → tenant exclusive → owned inventory/account/book → Order/reservation и current source-head locks. Она повторно читает authority, проверяет account/user/instrument/asset limits и атомарно сохраняет immutable decision/reservation, Portfolio commitment и outbox. Exact replay не создаёт второй effect; uncertain COMMIT не возвращает grant. Exchange I/O внутри транзакции отсутствует; blind mutation retry запрещён.

Reservations не удаляются по TTL при неизвестном dispatch: expiry запрещает новую отправку, но не освобождает потенциально потраченный баланс. Release разрешается по definitive non-submission/rejection/cancel/fill evidence. Stop strategy прекращает новые intents, но не забывает существующие orders/reservations. Leader/Redis lock лишь ускоряет coordination; корректность обеспечивают PostgreSQL constraints/CAS и [dispatch protocol](execution.md).

## Kill switch, circuit breaker и reduction

Pause scopes: strategy, user, connection, global, с durable epoch, reason, actor/time. Effective permission — пересечение всех уровней. Transact pause update и dispatch check используют общий gate; сценарий уже отправленного/in-flight запроса описан в execution. «Stop» и «close everything» — разные audited команды; close/cancel подтверждаются отдельно в UI.

Automatic circuit causes: stale market/private data, auth error, abnormal clock/latency, excessive rejects, exchange outage/maintenance, unavailable DB/Redis limiter, inconsistent balance/position. Half-open допускает health probes и reconciliation, не реальные пробные buy. Снятие автоматического circuit требует свежего согласованного состояния, не снимает пользовательский pause/LIVE grant restrictions.

Emergency cancel проверяет ownership, правильный order ID/environment и возможность отмены. Risk close проверяет подтверждённую position side/size, reduce-only либо эквивалентный native close, текущие execution filters, fee/balance и slippage constraints; не может увеличить absolute exposure. При неизвестной позиции/неподдерживаемой безопасной close semantics — отказ с эскалацией оператору, а не противоположный market order наугад. При недоступности critical infrastructure гарантировать автоматическое закрытие невозможно: нативные protective orders по возможности задаются заранее, пользователь видит их статус и ограничения.

## Проверки PHASE 12

Каждое правило проверяется на границе/за границей, нуле, отрицательных/невалидных decimal, metadata change и stale inputs. Property tests проверяют, что rounding quantity не увеличивает исходный размер, hard limits нельзя расширить user policy, reservations не создают отрицательные available funds, reduction не увеличивает exposure.

DB integration: две конкурентные стратегии, cross-account user cap, повтор intent/job, uncertain COMMIT, partial fill+cancel, unknown reservation expiry, lost DB response, external manual order, midnight/external cash flow, kill-switch race, leverage/mode change. Security integration: forged tenant/mode/risk approval/hash. Принятые Order Engine PLACE/CANCEL/native AMEND проходят один gateway; будущие manual, synthetic stop, TWAP slice и Paper callers обязаны использовать его. LIVE dispatch остаётся закрыт после этой приёмки.

## Принятая production authority chain

| Граница                        | Текущий контракт                                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable sources → certificate  | createPostgresRiskSnapshotStore читает ownership, current policies/rules/capabilities/permission epochs, Portfolio books/holds, open/pending/UNKNOWN orders, Market/FX/liquidity/health и UTC loss source graph в одном bounded consistency boundary; missing/stale/conflict → fail closed. |
| Certificate → reservation/hold | createPostgresOrderRiskPort().approve() повторно certifies current state, evaluates limits и сохраняет immutable decision/reservation плюс Portfolio COMMITMENT атомарно. Replay/restart не создают вторую reservation или monetary ledger effect; uncertain COMMIT не выдаёт grant.        |
| Attempt → transport            | Durable attempt предшествует I/O; permit/start timestamps остаются null до final current-state authorization непосредственно на HTTP handoff. Policy/rules/capability/permission/pause/health/deadline replacement до dispatch → NOT_SENT.                                                  |
| Native outcome → recovery      | ACK не финален; ambiguous outcome → UNKNOWN с retained hold, без blind retry. Native identity/causal history, fills и reconciled Portfolio cut определяют единственное authoritative application/release.                                                                                   |
| Native AMEND                   | Только Binance Spot TESTNET standalone LIMIT/GTC quantity reduction at unchanged price; immutable AMEND intent и permanent key, нулевой control hold с сохранением primary collateral, fill/amend races и restart-safe reconciliation. Fake cancel/create отсутствует.                      |

Native Market snapshot и Portfolio source reader сами не выдают RiskGrant и не создают monetary ledger effects, но входят в уже принятый certified coordinator. MARK/FX/liquidity/health/permission должны быть явными и свежими; LAST не переименовывается в MARK. Внешние aggregate locked и async order/balance reads не доказывают per-order collateral: positive native credit disabled, full conservative hold остаётся. [Исторические RED→GREEN checkpoints и CI](phase-12/verification.md) сохраняются отдельно; это текущий accepted contract, а не прежний incomplete checkpoint.
