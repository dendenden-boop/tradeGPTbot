# Initial PAPER reservation storage

Starting protected main: `cd733bb07ba052b97e7cfa59c6dd14da4d903c83`. All thirteen baseline commands passed before tracked changes. Native PostgreSQL RED at `e3c133e9e772d492a9e43ba6793a690c1d9b9e81` ([CI 39244692851](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39244692851)) failed all 15 new contracts because `vectorSize` and `reservation_debit` did not exist; all 1017 previous main-cohort assertions passed with their identities preserved. The native artifact's head, producer-job window and ZIP SHA256 were verified. Registry/role cohorts and this failed run are not full acceptance.

## Explicit shared representation

Additive migration 51, `202610190001_paper_reservation_vectors`, retains the common RiskReservation identity, decision/intent/account/storage-mode foreign keys, permanent decision uniqueness and SubmissionAttempt FK. It adds a conditional storage representation rather than a separate grant namespace.

| Storage form          | Parent budgetId / asset / amount | vectorSize | paperLegacy | Meaning                                      |
| --------------------- | -------------------------------- | ---------- | ----------- | -------------------------------------------- |
| TESTNET / DEMO / LIVE | All required by SQL CHECK        | NULL       | false       | Unchanged native scalar contract             |
| New PAPER             | All NULL; consumedAmount=0       | 1 or 2     | false       | Exact immutable positive cash vector         |
| Existing scalar PAPER | All original fields retained     | NULL       | true        | Quarantined; no vector or authority inferred |

Prisma marks the three scalar columns and budget relation nullable because PAPER has no single scalar debit. Native SQL still rejects any missing scalar field. No native admission/calculation/lifecycle function is replaced. A PAPER SELL can retain base principal and quote commission without flattening them, inventing a dummy monetary amount, or confusing valuation notional with cash. Authoritative valuation/model bounds remain a separate future certificate requirement.

The SQL-owned partial unique index permits one original new PAPER vector per tenant/intent permanently. Existing shared decision/intent/account/mode relationships and attempt IDs remain usable by the future common Order/Risk path; an unrelated-table UUID cannot substitute for a common reservation. This identity constraint alone is not an idempotent service or grant.

Each `ctp_paper.reservation_debit` has the exact tenant/reservation/intent/account/PAPER FK, ordinal, asset, positive cash amount and permanent hold UUID. Ordinals cover exactly 1..vectorSize; allocated assets and hold identities cannot duplicate. BUY stores quote only. SELL requires base and can additionally store allocated quote commission. A base-only SELL is a permitted storage shape, **not proof of zero fees or sufficient coverage**. The future coordinator must re-evaluate the immutable model bounds and authentic decision evidence.

Cash amounts use the shared Portfolio hold envelope: at most 20 integer and 18 fractional digits, positive and finite. NUMERIC has no rounding typmod. Decimal atoms, bounds and IDs never round through JS Number. A future reader must emit canonical decimal strings from SQL values; storage shape does not authenticate a source.

## Atomic original terms and authority boundary

Deferred constraints require each initial parent and its entire vector in the same committed transaction. New vector parents are ACTIVE/version0 with no releasedAt. Original parents/debits cannot be overwritten or deleted; private truncation is prohibited. Permanent uniqueness and retained originals prevent later identifier reuse or vector expansion. The concurrency contract observes the competing backend's actual lock before the winner commits, then requires exactly one complete vector. This proves storage identity arbitration, not atomic Risk/budget admission.

No runtime role receives private table/function permission. Forced RLS and exact scope remain mandatory. The migration holds an exclusive table lock and temporarily removes FORCE only for its owner's classification of existing PAPER rows, restoring it atomically. Pre-existing scalar PAPER reservations retain every original economic value, status, timestamp, ID and FK; they receive only the durable `paperLegacy=true` quarantine tag. No debit vector, cash credit, zero exposure, release or approval is inferred. Queued original constraints are explicitly validated before subsequent DDL, then deferral is restored; no constraint is skipped.

Any quarantined PAPER liability blocks new PAPER vectors for the entire tenant, including a different account. New callers cannot manufacture the legacy exemption, attach guessed debits to an old parent, overwrite/delete it or clear its tag. Quarantine is not a resolution mechanism. A future certified source must reject an unresolved legacy inventory rather than filter it out; authoritative recovery requires a separately accepted contract. Current PAPER admission remains disabled.

Source5bc3956 proved that unconditional refusal was incompatible with the repository's existing published upgrade fixture ([CI39250051896](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39250051896)); it is not acceptance. Regression tests were committed before the correction. The non-BYPASSRLS owner proof now requires actual populated50->51/repeated deploy with scalar values and dependent identities retained, no manufactured vector, forbidden backfill/forgery, tenant-wide blocking and all176 old private functions unchanged (two new=178). No legacy test data is deleted to make the upgrade pass.

This step implements **initial original-allocation storage only**. There is no PAPER update/release/UNKNOWN writer, certificate, approve(), RiskGrant, Portfolio COMMITMENT, financial posting, transport permit or dispatch. Storage fixtures deliberately are not accepted financial decisions. Golden tests require zero ledger/entry/outbox/attempt/Portfolio evidence effects. A new connection proves committed row persistence; it is not a server crash/restart or backup-recovery test.

The pristine source and current PAPER Risk/Order admission guards remain closed. A future certified writer must capture complete current inventory, authenticate decisions/model bounds, re-evaluate under GLOBAL -> tenant -> account/budget/reservation locks, atomically create actual Portfolio holds, retain UNKNOWN without expiry, authorize every reduction/release with durable ordering/tombstones, return no grant on uncertain COMMIT, and enforce final dispatch validation. Original allocations cannot be treated as current remaining liabilities without that lifecycle proof.

## Verification boundary

The first diagnostic CI stopped at fixture lint with native skipped; the second fixture had a proven UUID/text parameter inference error and was superseded/cancelled. Neither is product RED or acceptance. Explicit first-use UUID casts fixed four fixture queries. The corrected native RED above is separate. PGlite DDL/parser rehearsals are explicitly not native persistence/roles/concurrency acceptance.

The final suite adds 30 native contracts in fresh and non-BYPASSRLS owner databases, while preserving all prior 1260 native identities, 17 owner reports, unit/HTTP assertions, published migrations 1-50, native financial source, workflows, dependencies, cohorts and deadlines. Initial storage explicitly rejects PAPER AMEND; common AMEND audit fixtures use the existing disabled native account without exchange dispatch. Valid PAPER audit vectors are seeded only by a separate isolated owner fixture transaction; original assertions run through the actual runtime login, whose private SELECT/INSERT denial remains mandatory. Actual final local/CI results are recorded only after execution in [verification](verification.md) and [PR #32](https://github.com/dendenden-boop/tradeGPTbot/pull/32)/completion checkpoint; these requirements do not claim a pending run passed.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** Certified active/UNKNOWN source/history, atomic vector reservations and Portfolio holds, final validation, authenticated operational sensors/bootstrap/supervisor and virtual execution remain outstanding. LIVE/PAPER financial dispatch and positive native credit stay disabled; native AMEND remains Binance Spot TESTNET only. Real private exchange acceptance and production soak are not claimed.
