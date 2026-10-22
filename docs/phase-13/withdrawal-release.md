# PAPER release after an irreversible withdrawal

## Implementation checkpoint

The server-only factory and additive56 are implemented as a candidate. Local49wire/10runner/65native contracts and actual clean server restart pass; [verification](verification.md) preserves tests-first RED, the two candidate defects and explicit diagnostic limits. Full new-head regression, populated deploy/redeploy/reset and source/PR/protected-main CI remain pending. This is not accepted production release authority yet. Published1–55 remain immutable.

## Candidate scope

Starting accepted protected main is `00f96275771e75d0f30162dcf1adabae52bcf7af` ([PR39](https://github.com/dendenden-boop/tradeGPTbot/pull/39)). Published migrations1–55 are immutable. This increment must complete the collateral lifecycle of the existing [pre-dispatch withdrawal barrier](withdrawal-barrier.md), without enabling financial dispatch or claiming a public CANCEL acknowledgement.

Only a genuinely issued pristine PAPER Spot BUY PLACE with its exact irreversible durable NOT_SENT barrier may release its original full quote-cash hold. Expiry, caller status/fills, an old approval, a self-consistent receipt or UNKNOWN are never release authority. UNKNOWN keeps the full original vector. Other order/execution profiles remain unsupported by this release path.

The intended server-only factory is `createPostgresPaperWithdrawalRelease` on `@ctp/paper-engine/risk`. A strict request identifies the exact original admission, reservation, withdrawal event, permanent release event and expected original revision1. The existing bounded admission transport, restricted role and two fixed RPCs must be reused; no role, SQL, client, writer or authority override is accepted.

## Atomic terminal state and accounting

An additive migration must authenticate original immutable issuance, command, complete original debit, ACTIVE revision1, exact barrier, private causal book and the current RESERVED hold/watermark in one bounded transaction. Use the existing GLOBAL shared → tenant → user → sorted accounts → target Order → book → reservation lock order. A trading pause or replaced public metadata cannot prevent a safe negative lifecycle action, but cannot renew an approval either.

Original parent/debits and ACTIVE journal remain immutable allocation history. An additional private immutable forced-tenant-RLS terminal record must prove current RELEASED state, with permanent event/target uniqueness and the original barrier identity. Current Risk inventory must authenticate this terminal overlay and exclude its order, reservation and hold exactly once. It must retain all other live/UNKNOWN liabilities and must not impose an evicting or cumulative cap on terminal history. A historical parent or approval is never current permission.

Atomically remove only the original hold, retain a permanent released watermark/tombstone, append one actual common Portfolio RELEASE evidence/outbox and authenticated causal book revision. Independently replay the existing Portfolio reducer before COMMIT. Cash balances, ledger transactions/entries, original decisions/allocations, command, client sequence and public Order remain unchanged. The release receipt is not a grant, permit, transport result, CANCEL acknowledgement or monetary posting.

The immutable NOT_SENT barrier must continue to prohibit later attempts, fills, progress, control intents and synthetic terminal Order events. Common writers cannot erase, alter or resurrect released history. Native modes retain their accepted semantics and privileges.

## Replay and uncertainty

Exact same-event replay returns the original durable result after reconnection, rule refresh, pause and subsequent unrelated admissions. Changed semantics or a second release event for the target conflicts. Concurrency commits at most one release and one Portfolio effect. No caller result is returned before confirmed COMMIT. An uncertain COMMIT returns no release result; explicit readonly reconciliation returns historical COMMITTED or MISSING, without retrying a mutation. MISSING never authorizes release.

## Acceptance

Tests precede implementation. Required native contracts cover actual release and unchanged cash/original allocation, current Risk inventory after release, permanent replay/restart, conflicts/concurrency, lost COMMIT, missing barrier/UNKNOWN/pre-abort and private authority/tombstone protection. Wire contracts must validate exact scope/identities, reducer/economics, released watermark, strict payload shape and fixed RPCs before COMMIT. Protocol fixtures alone are not PostgreSQL durability or privilege acceptance.

Full local regression, actual native PostgreSQL/restart/non-BYPASSRLS owner, populated55→additive upgrade/redeploy/no inferred history/isolated reset, source/PR/protected-main Ubuntu/Windows/services/Docker/CodeQL and actual branch protection remain required. Preserve every earlier test, published migration and existing CI deadline. Actual outcomes belong in [verification](verification.md); this document is a contract, not evidence that the candidate is implemented or accepted.

**PHASE13 IN_PROGRESS / NOT READY FOR PHASE14.** Public CANCEL completion, partial/executed release and UNKNOWN resolution, final dispatch/attempt/permit ordering, shared durable virtual execution and operational composition remain outstanding. LIVE/PAPER financial dispatch and positive native credit stay disabled. Native AMEND is Binance Spot TESTNET only. Real private exchange acceptance, crash/backup restore and production soak are not claimed.
