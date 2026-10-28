# Prepared PAPER execution source

## Scope and authority

Starting protected main is `6c6db6a15f25e494b09a8460d8e681c99c7132b7` (accepted PR52). This increment composes the accepted [current execution source](execution-source.md) with the [original preparation journal](attempt-journal.md). It adds no SQL, grants, tables or migrations; published migrations 1–59 stay immutable.

`createPostgresPaperPreparedExecutionSource` is exported only through `@ctp/paper-engine/risk`. Its strict request contains `kind: PAPER_PREPARED_EXECUTION_CAPTURE`, an existing `preparationKey`, exact admission scope and current server authorization. Request input cannot provide a connection URL, SQL, tenant authority, preparation, market source or execution timestamp. Database configuration remains server-owned.

The immutable result contains the normalized request, current source `asOf`/`validUntil`, a correlation hash, complete current pristine FIFO and the target's original PREPARED attempt. Only the target preparation is joined. Other contenders retain their original admission descriptors; the reader does not invent their preparations or start times. The hash authenticates no caller and grants no authority.

## Shared transaction

The existing bounded admission database transport executes exactly one READ COMMITTED transaction and two fixed `SELECT ctp_paper.reconcile_admission($1::jsonb) AS result` calls:

1. `PAPER_EXECUTION_CAPTURE` verifies current ownership/permission epochs, current metadata/market/causal Portfolio and complete tenant inventory before looking up a preparation key. It retains the existing GLOBAL → tenant → verified owner/accounts/orders/book lock order and full original admission FIFO.
2. `PAPER_ATTEMPT_PREPARE` reads the original target preparation through the published readonly journal branch. Both calls share the same connection and existing transaction locks until COMMIT.

Readonly describes the selected RPC branches: no financial or journal write is invoked. This is not a `BEGIN READ ONLY` transaction, because the accepted kernel uses locking reads. SQL role boundaries, four pending slots, physical settling, deadlines and uncertain-COMMIT handling are unchanged.

The reader requires a COMMITTED journal view whose state is still PREPARED with no withdrawal. It compares the complete original admission descriptor against the current target candidate: binding, order/intent/reservation/decision, database instrument/rule, command/hash, lossless priority, admission time and original expiry. A future preparation time, missing target/key, UNKNOWN, NOT_SENT, stale source or conflicting history rejects. Freshness is checked before COMMIT and after response delivery; abort or uncertain COMMIT returns no result. There is no mutation retry.

Current market freshness and original admission expiry remain separate. An expired original grant can be returned as immutable history while the current source is fresh; no date or hash renews admission. Reader reopen recovers the durable original preparation rather than adopting a new attempt.

## Execution boundary remains pending

This result is current data plus immutable history. It is not a final Risk evaluation, eligibility decision, START, one-use permit, liquidity allocation, fill or Portfolio posting. The future atomic writer must reread all current policies, rules/capabilities, ownership/epochs, controls, health, reservations and relevant journal heads at its own final boundary, including other contenders' attempts. A readonly result cannot substitute for that check.

## Verification scope

Tests-first commit `32fe696` recorded 50 unit failures and a real PostgreSQL missing-factory regression before implementation. New unit coverage includes 300 FIFO candidates, priorities beyond JavaScript safe integers, exact shared transaction/SQL, admission mismatches, expired original history, schema rejection, reopen, abort, rollback, lost COMMIT and expiry after COMMIT delivery. The targeted runtime suite passes 146/146, including all 96 old source/journal cases. Five additional harness contracts retain every old native statement and unchanged process budgets; the targeted harness suite passes 41/41.

The new native test uses real configuration/funding/Order/admission/market/journal ports, two actually issued contenders, current authorization, MISSING and NOT_SENT rejection, reader close/reopen, and inventory comparisons proving no additional hold/cash/client-ID effect. The first local Windows diagnostic failed on stale fixture market evidence; a fresh publication corrected that input. The next failed because a second MARKET request exceeded the existing Risk limit; an explicit lifetime-bounded LIMIT contender corrected that fixture. Both failed runs are retained. The corrected selected diagnostic passes 1/1 with 61 explicitly filtered historical cases. All three owned clusters were shut down. Windows diagnostic startup-GUC compatibility and response-delivery instrumentation do not replace full Linux non-BYPASSRLS owner/cohort/upgrade/reset acceptance. Client reopen is not a new PostgreSQL crash/backup-restore drill.

Complete frozen regression and exact source/PR/main CI remain required before accepting this increment. **PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** LIVE/PAPER financial dispatch and positive native collateral credit stay disabled. Native AMEND remains Binance Spot TESTNET only. Real private exchange acceptance and production soak are not claimed.
