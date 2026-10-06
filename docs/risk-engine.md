# Risk Engine

PHASE 12 now includes coordinator source reconstruction and an explicit transactional persistence port: nine scoped source families, current graph comparison, lossless exposure/hold deduplication, fresh qualified FX and UTC external-flow-adjusted loss/peak replay. These functions do not authorize trading. The PostgreSQL RiskSnapshotStore/source backend, atomic production approve/reserve, Portfolio bridge, final current-policy gate and native AMEND remain outstanding; the test reference store is not production or native acceptance. See [current contracts](phase-12/contracts.md) and [verification](phase-12/verification.md). Gate remains NOT READY FOR PHASE 13; LIVE is disabled.

PHASE 0 — контракт и критерии проверки. Ни один manual/strategy/paper/demo/live order не должен обходить risk. Этот модуль не прогнозирует доходность; он ограничивает допустимые действия при известных данных.

PHASE 12 начата: независимый `@ctp/risk-engine` реализует первый increment чистых правил согласно [требованиям](phase-12/requirements.md) и [контрактам](phase-12/contracts.md). Результат EVALUATED не является durable RiskGrant. Атомарные reservations, certified snapshot coordinator, final dispatch/pause gate и AMEND lifecycle ещё обязательны; [verification](phase-12/verification.md) сохраняет NOT READY FOR PHASE 13. Ниже остаётся полный целевой contract, а не заявление о завершённом gateway.

Текущий evaluator требует position-mode evidence с exact NET quantity/account/source revision и отвергает HEDGE, включая реальный HTX linear profile. Цены и price bounds выражены в native quoteAsset; notional конвертируется в valuationAsset один раз, liquidity явно выражена в valuationAsset. FX доказывает обе валюты, source/time и IDENTITY/OBSERVED semantics, без stablecoin parity. Execution допускает только точную final-gate SQL function; эти guards не превращают caller-provided snapshot в authority.

## Интерфейс и входные данные

`evaluateAndReserve(intent, trustedContext) → RiskDecision` выполняется application service с транзакционным repository. Чистые функции отдельных правил получают immutable `RiskSnapshot`. Decision: APPROVED/REJECTED/RECONCILIATION_REQUIRED, список стабильных reason codes, normalized payload hash, policy/state/instrument versions, data timestamps, reservationId и expiresAt. Перед фактической отправкой execution вызывает `validateDispatch(decision, currentState)`; прежнее одобрение не является бессрочным разрешением.

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

Daily interval — UTC. Realized net включает realized trading PnL, fees и funding с явной учётной политикой; daily total loss — снижение equity, очищенное от net deposits/withdrawals/transfers и внутренних перемещений, без повторного вычета fees. Platform не делает withdrawals, но внешние movements счёта должна учитывать. High-watermark корректируется на внешние flows. При неизвестной valuation или переходе дня baseline не сбрасывается в пользу открытия риска — требуется reconstruction. Формулы и fixtures закрепляются до PHASE 12.

## Атомарное резервирование

Реализованный prerequisite PHASE 12: server-only createPostgresPolicies хранит immutable platform/user limits revisions и monotonic heads отдельно для PAPER/TESTNET/DEMO/LIVE. Permanent event replay/CAS переживает restart; отсутствие обеих policies или несовпадение valuationAsset закрывает current read. Policy publisher работает под отдельными SQL roles без финансовых writes; direct execution grant и смешанная Portfolio/controller роль не проходят SQL guard. Replacement участвует в GLOBAL → tenant ordering. Это источник policy versions для будущих approve/final checks; atomic Risk gateway и certified snapshot ещё не реализованы, policy read не выдаёт RiskGrant.

Две стратегии с доступными 100 USDT не должны одновременно получить независимые approvals по 80. Короткая транзакция берёт locks для user aggregate, account collateral и instrument budgets в одном стабильном порядке, повторно читает версии, проверяет общие и локальные limits, создаёт decision/reservation, обновляет budget version и outbox. SERIALIZABLE conflicts повторяются ограниченно с jitter до deadline; внешних действий внутри retry нет.

Reservations не удаляются по TTL при неизвестном dispatch: expiry запрещает новую отправку, но не освобождает потенциально потраченный баланс. Release разрешается по definitive non-submission/rejection/cancel/fill evidence. Stop strategy прекращает новые intents, но не забывает существующие orders/reservations. Leader/Redis lock лишь ускоряет coordination; корректность обеспечивают PostgreSQL constraints/CAS и [dispatch protocol](execution.md).

## Kill switch, circuit breaker и reduction

Pause scopes: strategy, user, connection, global, с durable epoch, reason, actor/time. Effective permission — пересечение всех уровней. Transact pause update и dispatch check используют общий gate; сценарий уже отправленного/in-flight запроса описан в execution. «Stop» и «close everything» — разные audited команды; close/cancel подтверждаются отдельно в UI.

Automatic circuit causes: stale market/private data, auth error, abnormal clock/latency, excessive rejects, exchange outage/maintenance, unavailable DB/Redis limiter, inconsistent balance/position. Half-open допускает health probes и reconciliation, не реальные пробные buy. Снятие автоматического circuit требует свежего согласованного состояния, не снимает пользовательский pause/LIVE grant restrictions.

Emergency cancel проверяет ownership, правильный order ID/environment и возможность отмены. Risk close проверяет подтверждённую position side/size, reduce-only либо эквивалентный native close, текущие execution filters, fee/balance и slippage constraints; не может увеличить absolute exposure. При неизвестной позиции/неподдерживаемой безопасной close semantics — отказ с эскалацией оператору, а не противоположный market order наугад. При недоступности critical infrastructure гарантировать автоматическое закрытие невозможно: нативные protective orders по возможности задаются заранее, пользователь видит их статус и ограничения.

## Проверки PHASE 12

Каждое правило проверяется на границе/за границей, нуле, отрицательных/невалидных decimal, metadata change и stale inputs. Property tests проверяют, что rounding quantity не увеличивает исходный размер, hard limits нельзя расширить user policy, reservations не создают отрицательные available funds, reduction не увеличивает exposure.

DB integration: две конкурентные стратегии, cross-account user cap, повтор intent/job, serialization retry, partial fill+cancel, unknown reservation expiry, lost DB response, external manual order, midnight/external cash flow, kill-switch race, leverage/mode change. Security integration: forged tenant/mode/risk approval/hash. Все paths включая manual, synthetic stop, TWAP slice, paper и demo проходят один gateway. LIVE dispatch остаётся закрыт до фактического прохождения этих тестов.

## PHASE 12 native Market Data source status

The new PostgreSQL Market Data evidence component persists native ticker/book pairs and gaps under ctp_market. It preserves permanent event identity and native sequence/time ordering through restart, rejects current DB rule mismatches and stale native observations, and prevents unchanged-book freshness laundering. Its isolated publisher has no accounting or Risk issuance authority. It is a source prerequisite, not the production certified RiskSnapshot backend or OrderRiskPort.approve. Missing native MARK/FX/liquidity/health/permission evidence must still deny coordinator admission; LAST is not relabelled MARK and stablecoin parity is not guessed.

PHASE 12 remains **NOT READY FOR PHASE 13** while physical authoritative snapshot composition, atomic shared-limit reservations, Portfolio hold/release recovery, current-state final dispatch and native AMEND lifecycle are incomplete or unverified. LIVE mutations remain disabled.
