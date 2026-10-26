# Native-free PAPER fill content

## Baseline and scope

Starting protected main **bcec05e44227863b1459c799928152e3e53541b6** accepted the pure execution-ledger calculation through [PR44](https://github.com/dendenden-boop/tradeGPTbot/pull/44), [Platform40336902670](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40336902670) and [CodeQL40336902808](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40336902808). Actual artifacts and API readback proved 5,031 unit / 41 HTTP per OS, 1,378 PostgreSQL cases, all owners/upgrades/Auth/Docker, twelve clean deployments, zero advisories and strict administrator-enforced main protection. All thirteen local baseline commands passed before edits with 826 tracked inputs unchanged.

The existing native Portfolio FILL content requires native fill/order identifiers. A simulated execution must not fabricate those identifiers. This increment adds the separate `paperFillEventSchema` / `PaperFillEvent` variant `PAPER_FILL` to the existing Portfolio event union. It supplies content and pure accounting integration only. It does not issue a private execution cause, reservation, grant, permit or committed fill, and introduces no financial writer or migration.

## Content and correlation

PAPER_FILL retains the common instrument/rule/metadata versions, internal order ID, timestamp, side, quantity, price, base and quote assets. It has no native object or exchange order ID. Its strict paper object contains the original `paper-<64 lowercase hex>` calculation fill ID, exact model version `spot-l2-taker-v1` and exact public MarketScope. The stable event ID is `paper-fill:<original fill ID>`, independent of the accounting implementation version.

Only Spot / NET / SPOT-bucket content is supported. Base and quote must differ. Zero fee is represented by an empty array; at most one positive quote-asset charge is allowed, with identical non-null quoteEquivalent and no FX field. Rebates, base/third-asset fees, duplicate charges, unknown fields, alternative model versions and caller-shaped grant/receipt/native fields reject. This is not proof that a fee came from the sealed model: the future private writer must independently verify complete economic provenance and exact source/model/rule binding.

The pure reducer requires exact PAPER mode, null private connection and matching public scope. A public LIVE market source is distinct from a private LIVE account. Native TESTNET/DEMO/LIVE accounts cannot consume PAPER_FILL. The server context must correlate event ID, SHA256 of the canonical parsed event and SHA256 of the exact canonical Portfolio binding.

**These plain hashes are correlation checks, not authentication or SQL provenance.** A JavaScript caller can compute them. They must come from a future fixed writer's independently authenticated capture in production; a matching object, proof-shaped body or successful pure reduction does not authorize money. No factory in this increment issues that authority.

## Accounting and denied persistence

The reducer shares the existing Spot principal, position basis, realized PnL and fee calculation. PnL is a projection; no extra PnL cash posting is added. Future timestamps, out-of-order economic events, missing snapshots, overselling and duplicate pending evidence remain rejected. Input remains unchanged. Fill accounting does not release, resize or resolve an UNKNOWN hold. Durable reservation progress must remain a separate authenticated effect in the same eventual execution transaction.

Existing native FILL schema/exports and native economic behavior remain intact. The only common fee-path adjustment safely narrows optional native FX for the new variant, whose schema forbids FX. Native arithmetic and FX freshness rules are unchanged.

The public PostgreSQL Portfolio store continues to reject every PAPER binding. It also unconditionally rejects PAPER_FILL presented with any native binding before operation SQL or connection acquisition. Even caller-supplied matching hashes cannot opt into persistence. Existing SQL permissions, native reconciliation, RLS, published migrations 1–57 and all earlier authorization/Risk/Order/adapter contracts are unchanged. A future additive private execution bridge must authenticate original issuance, current permission/policy/rules/health, ACTIVE reservation and durable attempt/one-use dispatch; atomically commit permanent fill replay, shared liquidity, ledger, Portfolio and hold progress; and reconcile uncertain COMMIT without blind retry.

## Verification

Tests-first **24cd6e0fda126a53d4bc9752633bd14ca7c3a126** produced 45 failed / zero passed / zero pending, all due to the missing PAPER schema. All 45 passed after implementation. TypeScript then identified four optional-FX union accesses; explicit safe narrowing repaired typing without changing native FX semantics. The complete Portfolio + Paper Engine selection passed **1,744 tests**, including all previous cases, cross-mode/scope rejection, honest native-free content, BUY/SELL basis/PnL/fee equality, pending replay, UNKNOWN retention and mocked-store zero additional SQL/connection calls.

The store protocol fixture mocks startup role admission deliberately; it does not prove PostgreSQL privileges or a trusted PAPER writer. Full new-head local regression and Ubuntu/Windows/native PostgreSQL/Auth/Docker/CodeQL acceptance remain required. Existing native suites prove preservation, not a new simulated financial authority. Compiled deployment checks retain all previous assertions and verify the exported schema. No real private exchange acceptance, crash/backup restore or production soak is claimed.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** Durable shared execution/fill replay, final dispatch/attempt/permit, trusted partial/UNKNOWN resolution and remaining feed/composition/exits/positions/PnL/reset are unfinished. LIVE/PAPER financial dispatch and positive native credit remain disabled; native AMEND remains Binance Spot TESTNET only.
