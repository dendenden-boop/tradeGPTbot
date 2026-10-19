# Conservative PAPER reservation state journal

Starting protected main: `bcfa5ce90730070afd686c2c408810164aac138c`, accepted through [PR #32](https://github.com/dendenden-boop/tradeGPTbot/pull/32), [main CI 39288519815](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39288519815) and [CodeQL 39288519807](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39288519807). All thirteen local baseline commands passed before this increment: 4438 unit / 41 HTTP, twelve clean deployments and audits zero. Published migrations 1–51 remain immutable.

## Storage contract

Additive migration 52, `202610190002_paper_reservation_state`, adds private `ctp_paper.reservation_state_event`. It retains the exact common tenant/reservation/intent/account/PAPER identity through a composite FK. It neither changes immutable original vectors nor turns the public parent's original ACTIVE/version0 into current lifecycle evidence. Legacy scalar PAPER quarantine remains unresolved and cannot acquire this journal.

| Revision | Status  | Predecessor                                     | Meaning                           |
| -------- | ------- | ----------------------------------------------- | --------------------------------- |
| 1        | ACTIVE  | None                                            | Explicit initial content record   |
| 2        | UNKNOWN | Revision 1, with strictly earlier observed time | Conservative uncertainty retained |

Each reservation has at most these two immutable records. This is bounded state per reservation; permanent PostgreSQL history grows with accepted reservation identities, without an in-memory cache, TTL eviction or identifier reuse. No UPDATE, DELETE or TRUNCATE is allowed. No initial records are inferred/backfilled for existing vectors; missing history is not an ACTIVE assertion or zero exposure.

UNKNOWN cannot become ACTIVE, RELEASED, RESOLVED or EXPIRED, nor receive another appended UNKNOWN. Expiry of an original reservation is not release authority. Full reduction/release, authoritative execution/reconciliation, remaining quantities and released tombstones require a separate accepted additive contract. No string flag, owner fixture, hash or elapsed time supplies that authority.

## Ordering, replay and transaction boundary

The private owner-only `append_reservation_state(uuid,uuid,uuid,bigint,text,bigint)` primitive requires exact tenant context and a complete nonlegacy PAPER vector. The existing immutable parent is locked to serialize appends. Direct owner INSERT receives the same scope/order checks; the helper is not a way around a table constraint.

The permanent key is tenant plus event UUID. Authoritative exact replay lookup precedes new transition validation, and is reread after acquiring the parent lock. An identical event returns its original record forever; a changed reservation, expected revision, status or observed time rejects with `PAPER_RESERVATION_STATE_CONFLICT`. Concurrent identical replay produces one record. Competing initial keys cannot both win. A key raced across different parents is reconciled to its immutable existing row rather than blindly republished.

An event receipt describes **that event**, not the current reservation state. Replaying revision 1 after revision 2 returns the original ACTIVE receipt while durable current history remains UNKNOWN. A future source must capture the complete latest revision and contiguous history with original allocations exactly once. It must reject missing/conflicting history and cannot use an old receipt as current approval.

Observed time is a lossless bounded integer in SQL; new time cannot be future, precede the original parent, equal or regress the last event. Revisions and times leave SQL as strings, without JS Number rounding. Sequence is checked from durable rows and survives new connections; no process-local watermark is authoritative.

The function runs in its caller's PostgreSQL transaction. Its returned JSON is uncommitted until COMMIT succeeds and grants nothing. It does not own a production connection/deadline, the GLOBAL → tenant → account/budget/reservation Risk lock set, or uncertain-COMMIT publication/recovery. A future certified writer must supply all of those guarantees and cannot return a RiskGrant from this primitive alone.

## Authority boundary

RLS remains enabled and forced. No runtime group receives table/column or function privileges; the new functions are SECURITY INVOKER with fixed `pg_catalog` search paths and PUBLIC execution revoked. This is private storage content, without a production publication/read port. Owner-only fixtures are deliberately not authenticated financial decisions or source completeness evidence.

No reservation reduction, Risk certificate/grant, Portfolio COMMITMENT, ledger effect, outbox, SubmissionAttempt, transport permit or dispatch is created. Existing pristine-only capture and PAPER financial guards remain closed. A future fixed coordinator/writer must authenticate decisions and model bounds, capture all ACTIVE/UNKNOWN liabilities and current hold proofs, atomically enforce budgets/Portfolio holds, retain uncertainty without expiry, and perform final validation.

## Verification

Tests-only source `d0ed8da1da0fdb952fc6adf5d5d87acb5e2ee990`, [native RED CI 39294451787](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39294451787), precedes production SQL. Actual native RED results are recorded in the verification checkpoint after artifact verification, not inferred from a queued run. PGlite preflight reproduced missing-function `42883`; the candidate subsequently passed 29 extracted serial SQL callbacks. Four physical connection/privilege/concurrency cases were explicitly excluded from that mock diagnostic. Neither PGlite result is native acceptance.

Acceptance requires all 33 new real PostgreSQL contracts fresh and under the actual non-BYPASSRLS owner, preserving all 1290 earlier native identities and 18 owner reports. The actual populated 51→52/repeated-deploy proof must retain every original parent/debit value and all 178 prior private functions, prove zero inferred journal records and unchanged legacy quarantine, and test forced owner RLS. New-connection persistence is not server crash/restart, backup recovery or production soak. Full thirteen-command local regression, source/PR/protected-main Ubuntu/Windows/PostgreSQL/Auth/Docker/CodeQL, exact artifact SHA/job-window/digest verification and branch protection remain required; pending checks are not PASS.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** General certified inventory/history, atomic vector Risk/Portfolio writer, definitive resolution, final dispatch validation, operational composition and virtual execution remain outstanding. LIVE/PAPER financial dispatch and positive native credit remain disabled; native AMEND stays Binance Spot TESTNET only. Real private exchange tests and production soak are not claimed.
