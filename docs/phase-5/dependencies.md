# Зависимости PHASE 5

Срез 2 октября 2026. Node 24.20.0 / pnpm 11.25.0 и прежние security/supply-chain policies сохранены. Direct versions и integrity закреплены в [lockfile](../../pnpm-lock.yaml); результаты — в [verification](verification.md).

| Изменение                | Версия / лицензия      | Решение                                                                                                          |
| ------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Runtime WebSocket client | ws 8.22.0 / MIT        | минимальный native WS client без скрытого SDK retry/host selection; compression выключена, bounded buffers/close |
| Type declarations        | @types/ws 8.18.2 / MIT | только devDependency; production exports не содержат tests/testing assembly                                      |
| Fastify security patch   | 5.12.3 → 5.12.5 / MIT  | исправление подтверждённого HTTP/2 trailers crash; API composition остаётся HTTP/1                               |

Из registry metadata: ws 8.22.0 опубликован 26 сентября, @types/ws 8.18.2 — 29 сентября, Fastify 5.12.5 — 16 сентября 2026. `minimumReleaseAge: 1440` не ослаблялся, exceptions не добавлялись. Zod 4.5.4 и Exchange Core переиспользованы; крупный exchange SDK отсутствует. Новые ws optional native addons не требуются.

Fastify [GHSA-4mh8-r7rc-xpvc](https://github.com/fastify/fastify/security/advisories/GHSA-4mh8-r7rc-xpvc) затрагивает HTTP/2 routes с reply.trailer(): uncaught exception завершает process. До dependency patch реальный disposable child HTTP/2 тест воспроизвёл ECONNRESET; после patch два запроса и trailers проходят без crash. Это подтверждённый defect зависимости завершённой базы, поэтому точечный patch допустим без переделки PHASE 1/3.

Полный audit сначала показал один moderate finding Fastify; после exact patch — нули всех severity. Артефакты: `test-results/phase5-audit-current.json`, `phase5-dependency-audit.json`, `phase5-fastify-metadata.json`, `phase5-fastify-trailer-before.json`, `phase5-fastify-trailer-after.json`. Историческая [оценка PHASE 1](../phase-1/dependencies.md) описывает тогдашний срез, а не текущую установленную версию Fastify.

Лицензии и release dates сверены с registry package metadata; upstream [ws](https://github.com/websockets/ws), [DefinitelyTyped ws](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/ws), [Fastify](https://github.com/fastify/fastify). Изолированный frozen production deployment Binance проверяет package imports без compiler/test runtime. Уязвимости могут появляться позднее; audit result относится к указанной дате проверки.
