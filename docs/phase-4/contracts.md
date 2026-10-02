# PHASE 4 — Контракт Exchange Core

Подтверждённые дополнения PHASE 5 описаны в [контракте Binance Adapter](../phase-5/contracts.md): общий algo имеет один внешний STOP trigger и child MARKET/LIMIT без второго trigger; BUY активируется при цене ≥ порога, SELL при цене ≤ порога. Balance.free/locked могут быть null, если exchange не предоставляет эти составляющие, а OrderBook.exchangeTime — null при отсутствии exchange timestamp. Требования к decimal, execution timestamps, storage и authorization сохраняются. RED/GREEN воспроизведения находятся в [отчёте PHASE 5](../phase-5/verification.md); исторический acceptance PHASE 4 не подменяет новую проверку.

Реализация: [public exports](../../packages/exchange-core/src/index.ts), [операции и schemas](../../packages/exchange-core/src/operations.ts), [adapter boundary](../../packages/exchange-core/src/adapter.ts). Пакет импортируется как `@ctp/exchange-core`. Это общий контракт с внедряемыми transport/authorization/registry, без реального подключения к бирже.

## Методы и результаты

Каждый из 33 методов принимает `(input, context)`. Для `connect`, `testConnection`, `getServerTime`, `getAccountInfo`, `getBalances` и `subscribeBalances` input — строгий пустой объект `{}`. Остальные input определены отдельными schemas, а `OperationInput<K>` / `OperationOutput<K>` дают тип конкретной операции. `execute<K>` использует тот же путь проверок; неизвестные имена отклоняются.

| Группа          | Методы                                                                                 |
| --------------- | -------------------------------------------------------------------------------------- |
| Lifecycle/time  | connect, testConnection, getServerTime                                                 |
| Account         | getAccountInfo, getBalances, getPositions                                              |
| Orders/fills    | getOpenOrders, getOrder, getOrderHistory, getTrades                                    |
| Instruments     | getSymbols, getSymbolInfo                                                              |
| Market data     | getTicker, getOrderBook, getHistoricalCandles                                          |
| Public streams  | subscribeTicker, subscribeTrades, subscribeOrderBook, subscribeCandles                 |
| Private streams | subscribePrivateOrders, subscribePositions, subscribeBalances                          |
| Mutations       | createOrder, cancelOrder, cancelAllOrders, amendOrder, setLeverage, changePositionMode |
| Algo            | createAlgoOrder, getAlgoOrder, cancelAlgoOrder, getAlgoHistory, subscribeAlgoOrders    |

Чтение возвращает `Result<T>` с `ok: true/value` либо `ok: false/error`. Поток — `Result<Subscription<T>>`. `disconnect(): Promise<void>` идемпотентен, закрывает adapter для новых запросов, отправляет abort всем pending/streams и ограничивает ожидание transport disconnect одной секундой. Завершение Promise не подтверждает, что некорректный transport освободил внешние ресурсы.

Mutation возвращает `ACCEPTED` с ACK, `DEFINITIVELY_REJECTED` с типизированной причиной либо `UNKNOWN`. ACK не является fill. Локальная ошибка до dispatch даёт definite reject; потеря ответа, abort, timeout или malformed ответ после dispatch дают UNKNOWN без retry. Transport может вернуть подтверждённый биржей reject, но generic core не доказывает правдивость такого ответа — это задача protocol adapter и его fixtures в PHASE 5–8.

`cancelAllOrders` принимает явный непустой batch до 100 отдельных authorized cancel commands. Отказ до отправки — `NOT_SENT`. После отправки — `RESULTS`, ровно один outcome на каждый commandId; неверный/неполный batch response делает исход всех отправленных команд UNKNOWN. Это не неограниченная команда «отменить всё» по произвольному аккаунту.

`getOrder` различает FOUND, NOT_FOUND_WITH_SCOPE с window/queriedIds и INDETERMINATE. Locator и возвращённый ID должны совпадать. NOT_FOUND не доказывает, что ранее отправленной команды не было вне указанного окна. `getOpenOrders` допускает только PENDING, OPEN, PARTIALLY_FILLED; terminal и UNKNOWN не выдаются за подтверждённо открытые ордера.

## Scope, authorization и ограничения ресурсов

`RequestContext` содержит полный immutable AdapterProfile, AccountScope или null, абсолютный deadline UTC milliseconds, AbortSignal и bounded correlationId. Profile включает exchange, region, market, environment, accountMode, profileVersion, endpointProfileId и optional opaque credentialRef. Ни URL, ни credentials не приходят в operation input. Private operation требует AccountScope с tenantId, connectionId, externalAccountId. Контекст обязан точно совпадать с профилем/аккаунтом экземпляра; ответы и stream events проверяются на ту же принадлежность.

Capability проверяется перед I/O по полному profile, adapterVersion, периоду evidence, instrument/timeframe constraints и feature. Исключения — lifecycle `connect`, `testConnection`, `getServerTime`: у них feature отсутствует, но context/deadline/scope проверяются. Для остальных операций недостающая, неоднозначная или UNVERIFIED запись закрывает вызов. Для order динамически учитываются MARKET/LIMIT, trigger/STOP_LIMIT, quote budget и reduceOnly; amend/algo/cancel имеют собственные gates. Enum OCO/trailing/attached TP-SL пока не означает наличие соответствующего command contract.

Mutation требует permit с commandId, dispatchAttemptId, normalized SHA-256 commandHash, profile/account и сроком не более 30 секунд. `computeCommandHash` связывает операцию, schema-validated команду и scope. Инъецируемый `AdapterAuthorizationPort.authorize` должен проверять durable intent/risk/reservation/attempt; без port разрешения нет. После await повторяются все time/scope/capability/rule/permit проверки. Этот интерфейс ещё не является durable authorizer и не предотвращает повторный dispatch через permissive test port. LIVE mutations отклоняются локально независимо от port.

Одновременно разрешены максимум 16 незавершённых работ и 16 источников streams на экземпляр; превышение возвращает BUSY. Request deadline — максимум 30 секунд от текущего clock. Timeout прекращает ожидание caller, но pending slot удерживается до фактического settling работы; stream slot — до settling source close. Поэтому неисправный transport исчерпывает ограниченную ёмкость, а не создаёт бесконечное число фоновых работ. AbortSignal должен исполняться transport. Эти ограничения не заменяют распределённые exchange rate quotas.

## Decimal, units и метаданные

[Decimal boundary](../../packages/exchange-core/src/decimal.ts) принимает только канонические строки: без exponent, leading zeros, trailing fractional zeros, `-0`, NaN/Infinity и JS number. Общий envelope — 30 integer + 18 fractional digits; price/quantity/amount — 20+18, rate — 2+18. Balance totals/available и Position PnL используют aggregate 30+18, совместимый с PHASE 2; minNotional использует storage amount 20+18. Положительность проверяется отдельно по смыслу поля. Вычисления используют отдельный Decimal clone с precision 100; нет изменения global Decimal configuration и нет скрытого округления. Overflow/лишняя scale дают отказ.

`quantize` явно задаёт DOWN (к минус бесконечности), UP (к плюс бесконечности) либо EXACT. Arbitrary step, включая 0.05, проверяется делимостью, а не числом знаков после запятой. Admission order ничего не округляет.

OrderSize различает BASE_QUANTITY с asset, QUOTE_BUDGET с quote asset и CONTRACTS с contractSpecVersion. Quote budget допустим только для MARKET BUY. Rules определяют единицы каждого инструмента, tick/step, quantity/price/notional bounds, order type и TIF. Для CONTRACTS notional использует contract size/unit; для BASE повторное умножение на contract size запрещено. Market order без limit price не получает вымышленный notional: необходима будущая свежая Risk valuation. Leverage/risk tier selection по фактической экспозиции не реализована.

InstrumentRegistry — порт. `createInstrumentRegistry` — ограниченная reference-реализация в памяти с явной ёмкостью 1–10 000 records и 2–100 000 исторических идентификаторов версий. Default version budget — `min(100000, max(128, capacity * 64))`. Повтор текущей идентичной записи идемпотентен; изменение содержимого без новой версии, возврат к старому version ID и откат effectiveAt отклоняются. Scope instrument/rules обязан совпадать; одинаковый exchangeSymbol у разных IDs внутри одного scope запрещён. Изменение symbol существующего ID допустимо с новой metadataVersion. История не вытесняется молча; нехватка ёмкости возвращает BUSY без частичного обновления. Последняя принятая запись остаётся до expiry: будущий refresh coordinator должен обрабатывать отказ обновления. Durable persistence и metadata refresh отсутствуют.

`AVAILABLE(value)` отличается от `UNAVAILABLE(reason)`. Нулевая цена не заменяет неизвестную. Storage `(filledQuantity=0, averageFillPrice=0)` преобразуется в UNAVAILABLE/NO_EXECUTIONS; положительный fill с storage average 0 отвергается. Входящий нормализованный order с положительным fill может честно содержать NOT_PROVIDED/STALE; valuation и будущий writer должны получить подтверждённую цену до учёта. Обратный mapping неизвестной цены в storage не реализован.

## Время, pagination и streams

External IDs — bounded opaque strings, включая цифровые строки за пределами Number safe integer. `normalizeExchangeTime` требует явные SECONDS/MILLISECONDS/MICROSECONDS/NANOSECONDS; default EXACT запрещает потерю sub-millisecond, TRUNCATE возвращает признак потери. Range соответствует неотрицательному JS Date UTC времени. Candle openTime выровнен по timeframe, closeTime — исключительная верхняя граница свечи.

История фильтруется по `[from, to)`: candles по openTime, fills по exchangeTime, orders по createdAt, algo по updatedAt. Candle может закрываться позже to: фильтр относится к openTime. Page содержит queryId, максимум 200 items и cursor; ответ не превышает запрошенный limit. HMAC cursor связывает operation/profile/account/все filters/queryId/limit, действует пять минут и только в данном экземпляре adapter. Restart делает его недействительным. Raw producer cursor ограничен 128 символами, public envelope — 2048.

`Subscription<T>` — один AsyncIterable consumer и максимум один pending next. Adapter queue имеет 64 DATA entries; общая utility допускает capacity 1–1024. RESYNC_REQUIRED (OVERFLOW/MALFORMED/SOURCE_GAP) явно завершает поток, очищая неполную очередь; event не теряется молча. CLOSED различает unsubscribe/abort/deadline/source close. Source close может дренировать очередь, unsubscribe/abort/deadline её очищают. Deadline подписки ограничен request deadline и expiry capability. Callback закрывает source один раз, в том числе при late handshake; malformed событие не попадает consumer. Проверка биржевых sequence/checksum и reconnect остаётся будущему protocol adapter/Market Data Engine.

## Связь с PHASE 2 и упаковка

[Storage boundary](../../packages/exchange-core/src/storage-boundary.ts) сохраняет PAPER отдельно от EXCHANGE_DEMO и точный TESTNET/DEMO subtype; LIVE не становится PAPER. PERPETUAL/FUTURES + isInverse + expiry преобразуются в точный market type, MARGIN/OPTION отклоняются. Prisma Decimal/Date objects не коэрцируются автоматически. Это не полный Prisma mapper: server-owned identity resolution, storage lifecycle mapping и writers остаются следующим модулям.

Test adapter собирается только в [контрактном тесте](../../packages/exchange-core/test/adapter.unit.test.ts) из factory и программируемого transport с [искусственными fixtures](../../packages/exchange-core/test/fixtures/adapter.ts). Никакого доступа к бирже или credentials нет. Package exports содержат только compiled `dist/index`; `test`, `src`, testing entrypoint и test factory отсутствуют в production deployment. API не импортирует Exchange Core.

Новая зависимость: `decimal.js` **10.6.0**, MIT, точная версия в lockfile. Основания: [официальный package manifest](https://github.com/MikeMcl/decimal.js/blob/master/package.json), [документация Decimal.clone/precision/rounding](https://mikemcl.github.io/decimal.js/). Runtime использует существующий Zod 4.5.4. Наличие audit PASS фиксируется отдельно в [verification](verification.md), а не выводится из лицензии или версии.
