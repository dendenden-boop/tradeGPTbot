# Требования, противоречия и допущения

Исходник: пользовательское задание `pasted-text.txt`, разделы 1–97. Дата анализа: 2026-09-05. Это спецификация PHASE 0; перечисленные функции не считаются реализованными.

## Решения по противоречиям

| Вопрос | Решение для проекта | Проверка / следующий gate |
| --- | --- | --- |
| «После каждого этапа pnpm checks» при PHASE 0 без проекта | Проверять документацию; runtime, lint TS, unit/integration честно N/A до bootstrap | В отчёте указать инструменты и отсутствие приложения, не выдумывать passed tests |
| PHASE 5–8 упоминают LIVE, Risk Engine только PHASE 12 | Реализовать протоколы и fixtures по порядку, production dispatch заблокировать до PHASE 11–12 и security gates | Никаких live execution tests в ранних адаптерах |
| Единый demo для всех бирж | PAPER, EXCHANGE_DEMO, LIVE различны; внутри demo хранить TESTNET или DEMO и точный профиль | Неизвестный HTX demo отключён; SDK example «demo» не означает sandbox |
| Один boolean capabilities на всю биржу | Трёхсостояниевая матрица по региону/счёту/рынку/инструменту/среде | Metadata + документированные условия + contract probes |
| Ровно один внешний эффект и сетевой timeout | Не обещать exactly-once; durable single dispatch + reconciliation, запрет blind retry | Lost-response, crash-before/after-send, late worker, истёкший client ID |
| Kill switch «запретить новые ордера», но разрешить cancel/close | Запретить увеличение риска; отдельные проверки cancellation и reduction | Close не может открыть обратную позицию; in-flight dispatch учитывается |
| 300 пар без нагрузки/числа пользователей | Базово 300 exchange-market-symbol keys суммарно; 600 stretch и 1200 четыре биржи | Hardware, event rate, accounts, users фиксируются в load report |
| 30s из минутных OHLC | Не восстанавливать несуществующие 30s; собирать из granular trades с quality/gaps | Missing interval остаётся incomplete; backtest отклоняет недостаточную историю |
| «Нельзя терять события» при bounded queues и сбое DB | Признать gap, остановить риск и восстановить из биржи; невозможно обещать отсутствие потерь при бесконечном outage | Не восстанавливается история — RECONCILIATION_REQUIRED и operator investigation |
| Unlimited ticks и full audit | Разные retention для market и финансовых событий, архив, privacy policy | Нельзя удалять нерешённые intents и их evidence по обычному TTL |
| Разные account/contract models | Начать Spot + USDT linear perpetual; dated/inverse включать по отдельной приёмке | Требование Futures сохраняется в roadmap, не объявляется выполненным первым адаптером |
| «Secrets никогда plaintext» | Только ciphertext at rest/в queue/log/UI; краткое plaintext в памяти подписывающего процесса неизбежно | Threat model учитывает runtime compromise и отсутствие гарантированного zeroization в JS |
| Запрет withdrawals vs warning о permissions | Withdrawal endpoint отсутствует; выявленный withdrawal permission блокирует LIVE в нашей политике | Если permission проверить нельзя — unverified, LIVE onboarding не завершён |
| Safety и Correctness имеют разный порядок в тексте | Инварианты сохранности средств и запрета дублей обязательны одновременно | Ни performance, ни удобство не снимают safety gate |

## Исходные допущения и открытые вопросы

Облачный провайдер, регион юридического лица, география пользователей, число connected accounts и бюджет инфраструктуры не заданы. PHASE 0 использует provider-neutral deployment, общий quote reporting asset USDT как настраиваемую единицу и RU-first UI. Это не вывод о доступности биржи в стране пользователя. Регион и eligible account profile выбираются до PHASE 5; публичные docs не подтверждают доступность конкретного счёта.

Базовый workload и RPO/RTO — проектные цели, а не SLA. Нагрузочные данные и эксплуатационная стоимость уточняются в PHASE 9/20. До production отдельно определяются юридические требования коммерческого сервиса, privacy/retention и права распространения market data; юридическое заключение в PHASE 0 не выдаётся.

## Покрытие исходного задания

| Разделы задания | Артефакт PHASE 0 | Реализация / проверка |
| --- | --- | --- |
| 1–4, 70, 77–80, 92, 96–97 | architecture, implementation-plan, verification | PHASE 1, gates каждого этапа |
| 5–8, 24, 43, 71, 93 | exchange-adapters, exchange research | PHASE 4–8, contract tests |
| 9–11, 44–45, 61, 81, 86, 95 | security, execution, ADR | PHASE 3–8, 12, 19, isolation E2E |
| 12–15, 39–41, 49, 51, 63–64, 67, 85 | market-data, architecture | PHASE 9/14/20, property/load/soak |
| 16–23, 60, 62, 66 | architecture, database, risk-engine | PHASE 13–16, единый Strategy API |
| 25–30, 48, 50, 57–59, 82–84 | execution, risk-engine, database | PHASE 10–12, concurrency/chaos |
| 31–33, 55, 65, 72–73, 91 | database, deployment | PHASE 2/10/22, migrations/restore |
| 34–38, 46, 56, 74–76, 87–89 | architecture, security | PHASE 17–18, RU/EN, ownership/reconnect |
| 42, 47, 52–54, 68–69, 90, 94 | deployment, plan, README | PHASE 1/19–22, CI/E2E/readiness |

## До реализации каждого существенного модуля

Разработчик уточняет requirements, edge cases, failure scenarios, interfaces и tests; затем пишет реализацию. Для exchange transport это malformed payload, clock skew, rate limit и потерянный ответ; для risk — два конкурентных intents и устаревшая оценка; для market data — gaps, duplicates и поздние trades; для auth — replay, revoke и cross-user access. Конкретные сценарии перечислены в профильных документах.
