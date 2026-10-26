# Durable unsent PAPER cancellation

## Verified durable unsent cancellation source and PR — 26 October 2026

Source **1c8a6e5b7552653edc13e0527975b0772ea0eaa5** passed complete source [Platform40295270980](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40295270980) / [CodeQL40295270909](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40295270909) and PR [Platform40295277024](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40295277024) / [CodeQL40295277143](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40295277143). Each OS passed 4,991 unit tests (1,590 Paper Engine cases), 41 HTTP cases and twelve clean deployments. Native PostgreSQL passed 1,378 tests in 42 files, including 47 admission-owner cases and all 19 earlier owner reports. All 4,955 prior unit and 1,370 prior native identities, original non-BYPASSRLS ownership, populated Prisma 56→57 deploy/redeploy/reset, Auth (108 users, 46 requests), Docker, zero advisories at all five severities, five artifact ZIP digests and producer windows per Platform run, and strict main protection were verified. All thirteen local checks passed with 823 tracked inputs unchanged, compiled server/root boundaries and audit provenance verified.

This verifies only genuine pristine issued PAPER Spot BUY cancellation after private NOT_SENT withdrawal and full release, with scoped UTC, immutable common intent/terminal evidence, permanent replay and no second financial effect. Executed/partial lifecycle, trusted UNKNOWN resolution, final dispatch/attempt/permit, durable shared virtual execution and operational composition remain outstanding. **PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** LIVE/PAPER financial dispatch and positive native credit stay disabled; native AMEND is Binance Spot TESTNET only. Real private exchange acceptance, crash/backup restore and production soak are not claimed.

Final documentation-head/protected-main publication and exact-main CI are recorded separately in [PR43](https://github.com/dendenden-boop/tradeGPTbot/pull/43). This is source/PR checkpoint evidence; older failed/pending checkpoints retain their historical results.

## Candidate scope and starting point

Starting protected main is `ff3703a3ab41476877ccc45763031dd741c39088`.
Published migrations 1–56 remain immutable. This contract describes the implemented candidate
PHASE 13 increment; complete acceptance remains pending. PHASE 13
remains IN_PROGRESS / NOT READY FOR PHASE 14.

Only a genuinely issued, pristine PAPER Spot BUY with an irreversible private
NOT_SENT withdrawal and a committed full collateral release may close locally.
The [content planner](unsent-cancellation.md) is an independent content check,
not authority. Native cancellation, AMEND and dispatch retain their contracts.

## Server boundary and permanent identity

`createPostgresPaperUnsentCancellation` belongs to the server-only PAPER Risk
lifecycle entrypoint. It reuses its physically bounded PostgreSQL transport and
two fixed RPCs, without granting a runtime role direct table access. Its input
is exactly `kind: PAPER_CANCEL_UNSENT`, binding, orderId, key and authorization
epochs (`permissionEpoch`, `userSessionEpoch`). Binding and epochs must come
from authenticated server composition; raw tenant IDs, JSON receipts, plans,
URLs and caller status are not trusted authorization.

Each operation rereads the active verified owner, exact account/PAPER/profile
identity and current permission/session epochs under GLOBAL → tenant → user →
sorted PAPER accounts → Order → book/reservation locks. Epochs use canonical
integer strings. Pause and metadata replacement cannot prevent an otherwise
authorized reduction of a proved NOT_SENT liability. Revoked ownership or stale
authorization does prevent it, including replay.

Permanent identity shares `(tenantId, CANCEL, key)` with common OrderIntent.
Semantic identity is the common hash of binding, orderId and operation CANCEL;
authorization epochs are current authority, not new command semantics. The
authoritative permanent lookup precedes pristine-target/rule admission. Exact
replay returns the original immutable receipt, IDs, client locator and command;
changed binding/target conflicts. A second key cannot close the same target.
Readonly reconciliation returns MISSING or the original COMMITTED result and
never starts a mutation, allocates an identity or retries uncertain COMMIT.

## Atomic common state and private cause

An additive migration must atomically persist a private immutable cancellation
cause, one common immutable CANCEL intent/command, one OrderEvent and one outbox
notification. The original PLACE intent, command, clientOrderId, client-ID
high-watermark, rule identity and economics remain unchanged. Common Order
changes only CREATED/version0/REQUIRED to CANCELED/version1/CONSISTENT, with a
server terminal timestamp and source `PAPER_NOT_SENT_CANCEL`. There is no native
observation, exchange ID, ACK, submission attempt, grant or transport permit.

Private provenance must authenticate actual issuance, withdrawal, release,
original full debit and durable Portfolio tombstone. Hash consistency alone is
insufficient. UNKNOWN, fills, attempts, conflicting controls, missing release,
caller-supplied evidence or expiry cannot establish this cause. Cancellation
adds no monetary posting, reservation, release, book revision or hold event.

Published withdrawal guards and admission inventory both need narrowly scoped
integration: only the exact authenticated local terminal cause may explain the
new common rows. Generic CANCELED/CANCEL labels, a GUC, arbitrary writer role or
serialized plan must never bypass the guard. Further execution/control writes
remain blocked. Inventory must remain healthy for subsequent genuine admission
while excluding the already released target exactly once. Delivered/deleted
outbox notifications are not durable authority.

One bounded transaction returns a result only after known COMMIT. Any ambiguous
COMMIT yields no receipt and requires readonly reconciliation. Concurrent exact
replays have one permanent result; conflicting keys/targets cannot create a
second cancellation. The provenance, tombstone and permanent key survive restart.

Session TimeZone must not change durable replay or provenance equality. New
cancellation snapshots and their causal validation use canonical UTC timestamps
within the private boundary; caller session settings must be restored after each
RPC. A different server/session zone cannot turn an exact replay into missing or
conflicting evidence, and does not authorize additional mutation.

## Required evidence

Tests precede implementation: strict wire rejection; genuine common state and
immutable PLACE; permanent replay after restart, pause and rules refresh; exact
epoch/ownership rejection; same-key and different-key concurrency; UNKNOWN,
attempt/fill/control rejection; no second financial effect; uncertain COMMIT and
readonly recovery; healthy subsequent inventory; direct writer/forgery and
private-role denial. Native PostgreSQL, non-BYPASSRLS ownership, populated
upgrade/redeploy/reset and all prior test identities remain mandatory.

Full format/docs/lint/typecheck/unit/HTTP/build/db/runtime/clean/audit and existing
Ubuntu/Windows/real-services/Docker/CodeQL CI are acceptance gates. No published
migration, CI deadline or old identity may be weakened to pass. LIVE/PAPER
financial dispatch and positive native credit remain disabled; native AMEND is
Binance Spot TESTNET only. Real private exchange acceptance, crash/backup restore
and production soak are not claimed.
