# PAPER journal to Portfolio Risk inventory

Starting protected main: `d4aaab8e45f762710fd72807148b13327c3c7670`, accepted through [PR #33](https://github.com/dendenden-boop/tradeGPTbot/pull/33), [main Platform 39302545404](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39302545404) and [CodeQL 39302545429](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39302545429). The source/PR/main exact-SHA artifacts, producer windows, ZIP SHA256 digests and strict branch protection were verified. Main passed 4438 unit /1223 Paper /41 HTTP, 1323 PostgreSQL assertions in41files, 33 new plus the same33 under the actual restricted owner, 19 owner reports, Auth/reset/Docker, twelve clean deployments and audits zero. Published migrations1–52 are immutable.

## Content contract

`projectPaperRiskJournalInventory(unknown)` joins immutable original PAPER reservation vectors, complete conservative state journals and common Portfolio commitment proofs into one tenant-wide content projection. Its output supplies balances/reservations/holds to the accepted vector budget calculation. It does not infer positions, order execution state, economic history, UTC loss or FX evidence.

The exact catalog has one to100 distinct PAPER accounts, including the target. Each has a distinct book identity, lossless positive SQL bigint revision, original capture time, reconciled Portfolio state and latest hold-event/watermark content. All captures belong to the exact tenant and valuation asset. An enclosing capture cannot renew a sibling: the oldest account witness bounds the entire result and validity uses the original stricter caller policy/model age (1–5000ms). A future fixed source must choose that age from current server policies/models, never from a user override.

Each original parent must retain the migration51 shape: ACTIVE/version0, nonlegacy, null scalar budget/asset/amount, zero consumed amount, no release, exactly one or two ordered debits. It carries exact common tenant/account/PAPER/decision/intent/reservation identities. The allocation additionally names its original order, instrument, base/quote, side, valuation notional and notional asset. These fields are content assertions; their authenticity must come from the future immutable issuance and source contract, not the public parent's APPROVE row or this projection.

The state source must provide its independently captured latest head and full contiguous history:

| Revision | Status  | Ordering                                          |
| -------- | ------- | ------------------------------------------------- |
| 1        | ACTIVE  | Observed at or after the original parent creation |
| 2        | UNKNOWN | Strictly after revision1                          |

The last record must match the head's exact event identity and revision. Every record must have exact tenant/account/PAPER/reservation/intent scope. Event time cannot exceed its account capture. SQL millisecond text is validated as canonical bounded integer text and compared with BigInt before conversion within Date's safe bound. No fractional, exponent, whitespace, leading-zero or rounded integer aliases are admitted. A separate non-continuable format stage prevents malformed revisions from reaching BigInt bound conversion.

Missing history, omitted UNKNOWN with a current revision2 head, a stale ACTIVE receipt, reordered or conflicting records, third transitions, RELEASED/EXPIRED/RESOLVED claims and legacy scalar quarantine reject. Parent status and expiration never weaken UNKNOWN. Original vectors remain whole: there is no inferred remaining amount, partial fill, release or resolution.

The latest journal state is checked against actual common Portfolio holds and their latest-event/watermark content with `projectPaperRiskCommitments`. Each leg needs one exact non-reflected hold for its asset and amount, and the same latest UNKNOWN state/time. Missing/orphan holds or proofs, duplicate identities, inconsistent balances, pending/unreconciled book data and unsupported native collateral credit reject. Gross PAPER ledger cash is preserved; commitments are not another monetary posting. The downstream budget deducts each hold once and takes one liability per reservation/order identity.

Reservation, decision, intent, order, hold and journal-event identities cannot be reused across any of the captured accounts. One instrument cannot change base/quote identity between siblings. Input is bounded to4MiB,100 accounts,1000 reservations/2000 hold proofs per account and10000 total reservation identities; no unbounded cache or historical ID eviction is introduced. Ordering output does not depend on account enumeration order.

## Authority and lifecycle limits

This function is pure. Serialized JSON can forge a mutually consistent catalog, head, journal and book; no content check can prove that a source omitted nothing. Consequently the result has **no completeness certificate, grant, permission epoch, permit, approval method or write path**. It cannot enter the accepted pristine capture as a replacement. A future fixed server-owned PostgreSQL transaction must authenticate every original issuance/model allocation, exact catalog and current head, all orders/economic history and hold watermarks while holding the shared Risk locks. Only that coordinator plus atomic admission may certify evidence.

The two-event migration52 contract remains conservative. Authoritative remaining quantities, repeated uncertainty, fill/cancel resolution and released tombstones need their own additive causal lifecycle contract before financial execution. No published migration, accepted native Risk/Order/Portfolio runtime, adapter, dependency pin, workflow/check context, existing test cohort or deadline changes here.

## Verification and gate

Tests must reproduce the missing projection before implementation, then cover journal/hold disagreement, stale replay after UNKNOWN, expiry, ordering/scope conflicts, cross-account identity reuse, 100-account content, lossless counters, malformed integer rejection, stable JSON reconstruction, exact budget deduction and sanitized capacity failure. JSON reconstruction is not PostgreSQL restart or source certification. A cross-package PostgreSQL contract reads actual original vector/journal rows and combines them with a clearly isolated pure Portfolio fixture; that fixture is not an issued Risk decision or authenticated SQL book.

The native runner's exact owner-assertion expectation increases from33to34 for this appended case. All33 earlier cases, the actual restricted owner, every other cohort/assertion and all original deadlines remain required. The initial eleven-file local regression is retained separately; a fresh complete regression binds all twelve final source/doc/test/runner inputs before acceptance.

Starting-main baseline initially failed the unchanged runtime deadline. A diagnostic using the same deadlines measured invalid-config process startup at4834ms/5000ms and normal shutdown at33ms/24ms under3000ms. The unmodified runtime repeat passed. The initial FAIL is retained; neither the diagnostic nor its repeat is reported as first-pass baseline success. Full remaining baseline, local regression and exact-head complete CI still require their actual results.

**PHASE13 IN_PROGRESS / NOT READY FOR PHASE14.** Certified active/UNKNOWN inventory/history, atomic vector Risk/Portfolio admission, causal lifecycle, final dispatch validation, operational sensors/bootstrap/supervisor and durable virtual execution remain outstanding. LIVE/PAPER financial dispatch and positive native credit remain disabled; native AMEND stays Binance Spot TESTNET only. No real private exchange acceptance, server crash recovery or production soak is claimed.
