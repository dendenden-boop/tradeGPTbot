# Common PAPER Portfolio bootstrap

## Scope

Start from protected main **11e51a2a5ce519344038ed151e4397d7303a5dbf**, accepted through [PR #11](https://github.com/dendenden-boop/tradeGPTbot/pull/11), [full CI 38295195972](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/38295195972) and [CodeQL 38295195966](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/38295195966). Published migrations 1–40 are immutable. The initial-only Portfolio reader intentionally rejects post-draft activity and remains unchanged.

This increment must initialize one durable common `ctp_portfolio.book` from an already proven PAPER seed, including accounts with ordinary common CREATED/PLACE drafts. No second ledger posting, parallel Paper balance ledger, reservation, Risk grant, fill, reset, transport permit or dispatch is authorized. An immutable historical bootstrap receipt is not a current Risk snapshot or permission to trade. Active holds and certified PAPER admission remain subsequent PHASE 13 work.

## Contract

- Separate server-owned bootstrap port; exact PAPER owner, null connection and sealed SIMULATED public-source/model identity. Owner/database configuration come from authenticated server composition. The API accepts no balances, wallet, book ID, timestamp, state or credential override.
- A new additive migration and isolated NOLOGIN group with only initialize/read RPCs. No direct table, native Portfolio, funding, Order, Risk or credential authority. Startup and each SQL operation reject changed/mixed/elevated/transitive roles and unexpected function/schema/column privileges.
- GLOBAL shared → tenant exclusive → current user/account → common book lock order. Retained configuration/funding seals, conserved closed common PAPER_SEED ledger and current active verified ownership must agree. No dummy native connection.
- Deterministic book/wallet/event identity derived from the permanent funding identity. One original common SNAPSHOT evidence and outbox entry, referencing the existing seed ledger. Common Portfolio balances remain lossless; no new ledger header/entry is inserted.
- Only unapplied ordinary PLACE drafts may exist. Reservations/decisions/attempts/fills/positions, changed order status, other monetary activity, arbitrary existing books or incomplete/conflicting provenance fail closed. Bounded inventory checks; account/tenant locks prevent racing financial activity.
- Immutable original receipt and independent retained seal; exact concurrent/restarted initialize/read returns the original receipt, book/event/revision and original snapshot time. Missing/corrupt book/evidence/origin never permits adoption, overwrite or reseeding. Bootstrap does not renew freshness on replay or reconstruct active state from initial balances.
- Only acknowledged COMMIT returns a receipt. Ambiguous COMMIT gives no result and no automatic retry; explicit same-owner read/replay resolves publication after restart. Four owned physical slots, bounded abort/deadline/close settlement and no hidden queue.

## Acceptance

First RED: real sealed configuration/funding and common draft need the absent durable bootstrap port. Then unit/native contracts for lossless projection, exact replay, concurrent/restart/lost-COMMIT, missing/corrupt provenance, ownership/source/current role, stale receipt versus current snapshot, financial activity denial, abort/deadline/slot recovery. Test fresh and non-BYPASSRLS function owners and populated published-40 upgrade. Existing financial/order/authorization and initial-reader guards must stay green.

Full format/docs/lint/typecheck/unit/HTTP/db:validate/build/runtime/clean/audit and complete source/PR/protected-main Ubuntu/Windows/native PostgreSQL/real-services/Docker/CodeQL acceptance are required. This candidate is not yet accepted.

## Candidate API and durable representation

`@ctp/paper-engine/portfolio` adds `createPostgresPaperPortfolioBootstrap` with `initialize(owner, io)`, `read(owner, io)` and `close`. Only the separate `ctp_paper_book_initializer` group may call `initialize_book(jsonb)` / `read_book_origin(jsonb)`; it gets no table or other function privileges. Only the new bootstrap factory requires additive migration 41. Existing factories and published migrations 1–40 are unchanged.

Book and outbox IDs equal the permanent funding UUID; wallet is `paper-initial:<fundingId>`, snapshot event is `paper-bootstrap:<fundingId>`. Revision is exactly one. The original common SNAPSHOT references the existing seed ledger and has no postings. Immutable `book_origin` and an independent `book_origin_seal` retain the original serialized receipt/checkpoint. Decode validates all common state fields against the retained receipts without converting money to Number. Bootstrap read returns a historical `INITIAL_BOOK`, with its original snapshot time; it has no current-source timestamp, permission epoch, reservation or grant. A matching checksum proves content consistency, not authorization or current Risk evidence.

Native RED confirmed the absent port with 894 existing passes and one new failure, followed by 35 private unit RED→GREEN contracts. The current working-tree implementation and its 32 native/owner contracts still require full regression/CI. No production Paper financial gateway is enabled.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**. LIVE/PAPER dispatch/positive native credit disabled. Native AMEND remains Binance Spot TESTNET only. Real private exchange acceptance and production soak are not claimed.
