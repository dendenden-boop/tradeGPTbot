# PHASE 13 conservative issued-reservation UNKNOWN

## Verified conservative UNKNOWN source and PR — 21 October 2026

Source **92cbee28bdc3ac65b36e470f5d0a9d39702e6cda** passed [Platform39568535472](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39568535472) and [CodeQL39568535532](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39568535532). Its [PR37 Platform39568542228](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39568542228) and [CodeQL39568543379](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39568543379) also passed. Exact HEAD, all five artifact ZIP digests and their producer windows were independently verified for each run; strict main protection was confirmed through GitHub API.

Both operating systems passed **4635 unit / 1401 Paper / 41 HTTP** cases. Native PostgreSQL passed **1357 tests in 42 files**, all 19 earlier owner reports and 26 admission/lifecycle owner cases, including retention of the original 34 state cases. Populated Prisma53→54 deploy/redeploy, no authority backfill, isolated reset, Auth with108 users, Docker, twelve clean deployments and audits0 passed. All earlier4620 unit and1348 native identities, all53 published migrations, native financial runtime and CI budgets remain intact. Corrected source also passed all thirteen frozen local checks with795 tracked input hashes unchanged. The separately filtered pre54 upgrade producer passed all17 original admission cases; its nine excluded post54 cases are exercised by the complete26-case owner/cohort runs, not counted as full-suite skips.

Source native cohorts completed in433299ms and the database parent in949704ms; PR measurements were450947ms and987533ms. These remain below the unchanged480000ms native and1020000ms parent limits. They are CI observations, not production throughput or soak evidence. Earlier failed source39563734944/PR39563847431 and their published52 TRUNCATE regression remain recorded below; no unchanged-source retry or waiver was used.

The accepted source implements only conservative durable UNKNOWN for an actual initial PAPER issuance: full original hold/vector and cash retained, permanent event replay, read-only uncertain-COMMIT reconciliation, and blocked fresh approval/new risk after quarantine. An earlier overlapping receipt is not dispatch authority; the future final dispatcher must recheck current lifecycle state. Trusted remaining/release/tombstones/terminal resolution, CANCEL controls, final dispatch/attempt/permit ordering, operational composition and durable virtual execution remain outstanding. **PHASE13 IN_PROGRESS / NOT READY FOR PHASE14.** LIVE/PAPER financial dispatch and positive native credit remain disabled; native AMEND is Binance Spot TESTNET only. Real private exchange, crash/restore and production soak are not claimed.

This is source/PR checkpoint evidence. Final-documentation and exact protected-main publication evidence is tracked in [PR37](https://github.com/dendenden-boop/tradeGPTbot/pull/37); earlier sections retain their historical source scope.

## Initial candidate scope (historical checkpoint) — 21 October 2026

Starting accepted main is `6c14e7c2819ec33324e5b9951ec2ea1abac6f700`:
[Platform39555795133](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39555795133)
and [CodeQL39555795089](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39555795089)
passed. Baseline on that exact clean HEAD passed all thirteen existing local
checks with 790 tracked inputs unchanged. This document specifies the next
candidate increment; it does not claim candidate CI or complete PHASE 13 acceptance.

`createPostgresPaperReservationLifecycle` is available only on the server
`@ctp/paper-engine/risk` subpath. It conservatively quarantines an actual initial
Spot BUY issuance from migration53. It cannot issue an approval, RiskGrant,
transport permit, release, trusted resolution, CANCEL reservation or dispatch.
No application composition enables PAPER financial I/O. LIVE remains disabled.

## Authority and ordering

The strict `PAPER_RESERVATION_UNKNOWN` request contains the original admission
lookup (exact tenant/account/PAPER/null connection/external account/server
profile/order/PLACE intent/command hash), reservation ID, permanent tenant/event
UUID and expected state revision `1`. It accepts no caller timestamp, snapshot,
balance, amount, resolved flag, SQL, RPC, role, client or authority callback.
These identifiers select authoritative database records; none is proof by itself.

Additive54 authenticates the actual immutable command and migration53 issuance,
original complete debit vector, current private book head, common Portfolio hold
and durable watermark. The same fixed two RPCs and restricted
`ctp_paper_risk_admission` role are used. Private legacy53 bodies and the new
lifecycle helper have no runtime/PUBLIC EXECUTE grant. The constructor and SQL
role boundary still allow only `evaluate_and_reserve(jsonb)` and
`reconcile_admission(jsonb)`.

One bounded PostgreSQL transaction takes the existing GLOBAL shared lock, tenant
lock, user row, sorted PAPER accounts, common book and reservation locks. It
appends state revision2 UNKNOWN using server time strictly after revision1,
replaces only that original hold's status with UNKNOWN, updates its durable
watermark, appends common evidence/outbox and a private immutable cause/book
event, and advances the private head. The existing 100-account bound and
safe book-revision bound apply. Equal/regressed server time fails closed; no
future time is synthesized. Original reservation parent, decision, debit amounts,
capital, cash postings and ledger entries remain immutable and unchanged.

The new private event has exact issuance/book foreign keys, deferred exact
immutable state-event/revision/time checks, forced tenant
RLS, permanent event/reservation uniqueness, immutable rows and no runtime table
access. Deferred consistency checks admit UNKNOWN only with that genuine cause.
A common Portfolio writer cannot release the hold, resurrect ACTIVE, erase its
watermark or bypass the private head. The original state-hash CHECK remains
enabled; the predecessor CHECK additionally admits an authenticated UNKNOWN cause.
Migration54 backfills no authority. Migrations1–53 are not edited.

## Replay, uncertainty and money

An identical permanent event replay returns its original immutable historical
receipt and creates no second state/evidence/outbox/head/reservation/cash effect.
A conflicting event or another event for the already quarantined reservation is
rejected. Revision2 never transitions back through this API. Restart does not
reset event identity or watermark. The receipt is historical information, not a
grant. Existing Order Engine permanent CREATE replay is unchanged.

`approve` cannot return a usable receipt for the quarantined intent; new risk is
also rejected by the conservative current-inventory guard. Historical
`reconcileApproval` can still describe the original issuance. A final dispatcher
must eventually consult current lifecycle state; implementing that dispatcher is
outside this increment, and dispatch remains disabled.

`markUnknown` independently reduces the returned common Portfolio transition
before COMMIT, checks exact binding, hold identity/economics, old fingerprint,
monotone event time/revisions, unchanged cash and after-state hash. The fixed SQL
kernel establishes source authenticity; serialized matching JSON is never an
alternative authority path. Existing physical socket ownership, four slots,
deadline/abort settlement and uncertain-COMMIT handling are reused unchanged.
Uncertain COMMIT returns no receipt. `reconcileUnknown` performs a fixed read-only
lookup: COMMITTED describes the original event; MISSING proves no release,
resolution, retry permission or available money. No blind mutation retry occurs.

## Verification and boundaries

Tests-first checkpoint `d3aef5b` precedes implementation. Configured unit RED
reported the absent lifecycle module. On actual published53 PostgreSQL all six
initial lifecycle contracts reproduced rejection of the missing UNKNOWN API.
The first ECONNREFUSED diagnostic was infrastructure failure, not contract RED.
An early candidate54 owner run exposed the wrong automatically named chain
CHECK; a separate catalog RED pinned both original hash and predecessor
constraints before correction. A mixed local function-owner diagnostic is not
fresh/restricted-owner acceptance. Failed evidence remains in the local
`test-results/phase13-reservation-lifecycle` checkpoint directory.

Initial full source39563734944/PR39563847431 CI additionally caught a cross-phase
compatibility regression: an inbound FK on the published52 state journal caused
PostgreSQL0A000 before its required immutable TRUNCATE guard could return23514.
Tests-first42b5585 pins the original guard in the new lifecycle case. The corrected
unpublished54 retains exact deferred state-event/revision/time validation without
that inbound FK. All26fresh54 lifecycle/admission and34unchanged state cases pass
locally, including the original guard; both earlier failed CI runs remain failures.
Full new-head regression and CI are still required.

Candidate verification includes exact replay/connection restart, concurrent
distinct event keys, conflict/stale revision, authoritative full hold retention,
lost acknowledged COMMIT, MISSING/abort, pause/rule replacement, common-writer
release/resurrection/watermark attacks, private helper/legacy signature denial,
and catalog constraint retention. The real runner also preserves populated53
issuance/holds/heads through Prisma54 deploy/redeploy with no backfill; full
native owner/Ubuntu/Windows/services/Docker/CodeQL acceptance is required.

**PHASE13 IN_PROGRESS / NOT READY FOR PHASE14.** Remaining/release/tombstones with
trusted terminal resolution, CANCEL controls, final dispatch/attempt/permit
ordering, operational composition and durable virtual execution remain future
PHASE13 work. This conservative quarantine is not proof of an ambiguous transport
dispatch or a final execution outcome. Positive native collateral credit stays
disabled; native AMEND remains Binance Spot TESTNET only. Real private exchange
acceptance, crash/restore recovery and production soak are not claimed.
