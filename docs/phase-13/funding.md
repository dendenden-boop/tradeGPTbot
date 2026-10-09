# PAPER initial funding contract

This increment implements initial server-owned funding only. It is not a Paper execution gateway, Portfolio certificate or Risk grant. PHASE 13 remains **IN PROGRESS / NOT READY FOR PHASE 14**. PAPER order dispatch and LIVE remain disabled.

## Authority and lifecycle

The compiled `@ctp/paper-engine/funding` subpath exposes `createPostgresPaperFunding`, `initialize`, `read` and `close`. A separately provisioned restricted login belongs only to NOLOGIN `ctp_paper_funding`. It can execute exactly `ctp_paper.initialize_funding(text)` and `ctp_paper.read_funding(jsonb)`; it has no direct public/private table or column privileges, configuration writer, credential reader, Risk, Order, reservation, native mutation or transport authority. Startup and SQL independently reject elevation, mixed/transitive role membership, LOGIN grouping roles, schema ownership/CREATE and extra private function grants, including overloads.

The authenticated server derives exact tenant/account/PAPER ownership and selects permanent funding ID, accepted configuration ID and starting asset amounts. No HTTP route is added. Never trust request-body tenant IDs, raw credentials, URLs, display balances or user-selected funding as authority. The PostgreSQL URL/environment remain server controlled; staging/production require verify-full TLS.

An already provisioned active verified tenant and active PAPER/SIMULATED account with no private connection must match the original configuration profile, external identity, client epoch and independent seal. Funding accepts 1–32 unique assets in strictly increasing ASCII order, with canonical positive decimal strings within the common 20 integer / 18 fractional digit amount envelope. No number conversion, arbitrary bucket, FX sum, reset epoch, top-up or model override is accepted. One initial funding per account is permanent. Reset and subsequent funding are unsupported until their explicit lifecycle is implemented.

## One monetary effect

Additive migration 37 introduces private immutable `initial_funding` and independent `funding_seal`, both tenant FORCE RLS. Published migrations 1–36 stay byte-for-byte unchanged. Configuration/model authority remains separate from monetary initialization.

Only the existing common `ledger_transaction` and `ledger_entry` hold money. One `PAPER_SEED` posting uses funding ID as transaction ID and permanent `paper-initial:<id>` cause identity. Each asset has one positive AVAILABLE entry and equal negative EXTERNAL entry. Existing deferred conservation and closed-posting guards are checked before returning the wire receipt. Funding does not create another monetary ledger, public PaperAccount, Portfolio book, Risk decision/reservation, Order Intent, outbox or transport permit. Future Portfolio/PnL projections must consume this same posting without another credit.

The transaction takes the existing GLOBAL shared control lock, tenant financial advisory lock, funding-ID lock, then tenant/account ownership row locks. Initial funding is allowed while controls are PAUSED because it authorizes no order or dispatch. It cannot change control state. A pristine account is required: arbitrary pre-existing public ledger postings, Intents, reservations or Portfolio books reject; unproven money is never adopted as a trusted seed.

Exact same-ID/same-semantic replay after restart returns the original receipt, timestamp and ledger transaction without more entries. Changed amount/configuration/ID conflicts; IDs cannot move across tenants/accounts. Read/replay validate current ownership, original configuration hash/identity, coherent funding request/receipt, retained independent receipt hash and actual closed ledger header/entries. Missing seals, coherent rewrites against the original hash or conserved-but-different ledger entries fail closed. No repair reconstructs provenance from mutable display records or freshly hashes a rewritten receipt.

## Physical settlement and recovery

Four physical PostgreSQL operations maximum, no hidden pending queue. Strict IO validation precedes socket allocation; abort/deadline/close destroys the owned socket. Connection/server/query/whole-operation deadlines are bounded. Only acknowledged COMMIT returns a receipt. An ambiguous COMMIT returns `PAPER_FUNDING_UNCERTAIN` with no grant or automatic retry. Explicit read or exact replay reconciles whether the single seed committed; a different ID cannot compensate for uncertainty. Back up funding receipt/seal, original configuration/seal, account identity and common ledger together. Losing provenance must halt use, not create replacement funding.

## Remaining phase scope

No certified PAPER Portfolio ownership path, common atomic Risk admission/reservation, durable market evidence/liquidity allocation, virtual order/fill worker, reset, positions/PnL or conditional exits are accepted by this increment. Accepted native Risk/Order/Portfolio, adapters and migrations are unchanged. Only Binance Spot TESTNET native AMEND remains supported; conservative collateral has no positive native credit. Real private exchange acceptance and production soak are not claimed. See [verification](verification.md).
