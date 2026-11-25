# Current durable-order Risk source

Accepted baseline for the next change: main `b7ec33cd2c2e742cbe004dc07d27969f52c39805` after PR78. Its own-main CI passed 6,675 unit and 41 HTTP tests per OS, 1,528 PostgreSQL tests, 24 owner suites, and 49 writer/capture cases. Migration 71 upgrade/redeploy, reset, compiled restart, all six artifact sets, and audit zero were verified. [Platform 45060423500](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/45060423500), [CodeQL 45060423501](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/45060423501).

Historical source checkpoint: `764d773eaa0a3fa01d9d77e220ade37caed66eea`. All 13 local commands, both CodeQL workflows and all 19 source/PR checks passed. The reports covered 6,602 unit tests per OS, 1,528 PostgreSQL tests, 24 owners, 49 writer/capture cases, migration 71 populated upgrade/redeploy/reset/compiled restart, twelve clean deployments and audit zero. The twelve ZIP digests and run windows, four raw native logs and prior case identities were verified. Protected publication and independent main CI were pending at this checkpoint. [Source Platform 43815054605](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43815054605), [PR Platform 43815060638](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43815060638).

Status: PHASE 13 candidate, **IN_PROGRESS / NOT READY FOR PHASE 14**.
The source supplies server-owned capture/evaluation for a second untouched
durable intent over the accepted single-execution book. Atomic postexecution
admission, Risk grants and dispatch remain outside this reader's authority.

## Request and authentication

The server-only `@ctp/paper-engine/risk` entrypoint provides
`createPostgresPaperCurrentOrderRiskSource(options)`. Its fixed `capture`,
`readCurrent` and `advanceLoss` methods use the existing bounded admission
database transport and restricted `ctp_paper_risk_admission` role. Neither a
backend/SQL callback nor caller command, certificate, clock or role is accepted.

The strict request contains exactly `kind: PAPER_CURRENT_ORDER_RISK_CAPTURE`,
`source` (the existing six-field `PAPER_CURRENT_RISK_CERTIFY` selector for the
original execution) and `target: {orderId, intentId, commandHash}`. Method names
select the fixed SQL operation; callers cannot supply a different operation or
evidence graph. Exact tenant/account/PAPER/profile, user-session and permission
epochs remain mandatory. Returned JSON is evidence content, never portable
authorization for a later transaction.

Additive migration 71 introduces private function siblings and a dispatcher.
Published migrations 1–70, the original historical/current readers and all
financial writers remain unchanged. The original readers continue rejecting an
additional target draft. Only the new inventory path allows exactly one selected
target after independently authenticating its real immutable command, binding,
request/command hashes, public intent/order scope, current metadata, allocated
client identity, initial CREATE event and untouched progress. It requires
`CREATED`, version zero, no dispatch, fills, reservation or other native history.
Another unselected draft or unsupported history rejects the entire capture.

The source retains the accepted GLOBAL → tenant/user → sorted account/book/order
lock boundary and market-key/catalog locks. It captures current policies, rules,
capabilities, runtime health, controls, market/FX/liquidity, complete supported
inventory and durable UTC loss evidence. All existing native-time ticker conflict,
freshness, conservative collateral, bounded catch-up and finite-lease guards stay
in force. A new intent uses current rules; the original execution retains its
historical rules. Missing, stale, conflicting or incomplete evidence fails closed.

## Counting and result

The certificate keeps the actual count of all tenant PAPER intents in its captured
minute bucket, including the new durable target. The internal stored-target
calculator removes exactly this authenticated intent from the policy proposal's
starting count when its durable `createdAt` belongs to that bucket; the common
policy then adds the proposal once. It uses certificate creation time, not a
later read clock. A target newer than its certificate or an impossible zero count
is rejected. An older target outside the captured bucket receives no subtraction.
The public pure calculator for an unpersisted proposal retains its original
semantics; no caller-supplied counter adjustment is exposed by either entrypoint.

The immutable result binds the real target command and scope, finite current
certificate and calculation. `EVALUATED` means arithmetic/policy evaluation only.
Existing position, residual order exposure, reservations and holds are counted
once. Fee coverage remains separate. The atomic writer independently repeats
current capture and evaluation in its own bounded transaction.

The server reader includes an immutable `commitmentBasis` when the result is
`EVALUATED`. It binds the selected order, intent and command hash to the exact
executed Portfolio book ID, revision and canonical state hash, and to the
current certificate ID, hash and evaluation deadline. The reader recomputes
spendable quote from the certified Portfolio balance and existing unreflected
holds, then checks both sides of the proposed debit against Risk. The proposal
describes one unreflected `RESERVED` hold. The reservation transaction assigns
the event and hold identities and owns idempotency, the revision compare-and-set
and all durable effects. A rejected evaluation has `commitmentBasis: null`.
Capture remains read-only for holds, balances, positions and the monetary ledger.

The basis includes the exact `nextRevision` for a possible successor.
PostgreSQL derives the book ID and revision from the locked execution capture,
verifies account ownership, hold identity uniqueness and remaining spendable
quote, then projects one additional hold without an assigned identity. The
TypeScript reader verifies that exact revision and projection before COMMIT.
Balances, positions, prior holds and all other Portfolio fields must match the
authenticated state. An UNKNOWN hold, exhausted revision or insufficient
spendable quote blocks the projection.

The fixed capture query calls the authenticated RPC once. PostgreSQL uses that
same result under the same transaction locks to derive the quote debit from the
durable command, current tick and lot, and certified fee model. It computes the
fee ceiling per lot and subtracts each unreflected quote hold once from the
executed Portfolio cash. Capture and reconciliation both require this result
to match the TypeScript asset, debit, prior availability and remaining cash
before COMMIT. A missing result or a discrepancy fails closed. PostgreSQL uses
`numeric` and the wire uses decimal strings.

PostgreSQL also marks the filled quantity at the current price and values any
active residual at its original price bound and tick. The supported graph has
one executed instrument and pristine siblings, so the same exposure contributes
to the instrument, asset, account, and tenant budgets. The residual contributes
one open order, with at most one existing potential position for the instrument.
The query applies both captured policies to the proposed notional, the four
projected exposures, the remaining cash floor, and the open-order, position, and
minute budgets. It adds the durable target to the minute budget only if the
target falls outside the already captured bucket. A successful capture requires
agreement with the TypeScript budget and affirmative SQL limits before COMMIT.

For the same capture, PostgreSQL independently checks the current executable
price bounds, quote notional, identity valuation, leverage, price deviation,
spread and participation-adjusted liquidity against both policies. It compares
the sealed current UTC loss baseline with both realized-loss, total-loss and
drawdown limits. Equality at a positive loss limit blocks admission. A successful
TypeScript result also requires both SQL verdicts and exact agreement on
liquidity before COMMIT. The query uses the source's authenticated data and
accepts no caller-provided amounts or market facts.

PostgreSQL also checks the runtime publication and trading controls from that
certificate. A successful capture requires the exact target owner, matching
configuration seals, permission and user-session epochs, account revision
and all nine healthy dependencies. Probe timestamps must fit the sealed
runtime interval and the certificate lease. The controls require one
RUNNING global kill switch, no stopped tenant kill switch or active pause,
and closed global, tenant and stored circuit breakers.

An independent order check matches the persisted target's instrument and
rule IDs to the captured market key and validates the exact rule revision,
trading status and validity interval. It checks the supported order type,
time in force, base asset, type-specific quantity bounds, lot and limit
price tick without rounding the command. The synthetic capability must
belong to the same runtime publication and certificate lifetime. Both
verdicts must be affirmative before an evaluated capture can commit.

The read-side capture and the reservation writer each obtain current evidence
under their own transaction locks.

The original execution validator currently requires the first execution's book
revision to be the current head and expects a single issuance and hold
watermark. The reservation transaction must add a causal successor that the
database can authenticate while preserving permanent historical replay of the
original execution. Extending the head or adding an issuance without that
proof would break the accepted replay contract.

Additive [migration 72](../../packages/database/prisma/migrations/202611240001_paper_postexecution_reservation/migration.sql)
installs one such successor. It retains every first-execution fill, ledger and
order check and accepts the next head only with the associated certificate,
active debit and Portfolio evidence. A single migration transaction installs
the cause, constraints, fixed SQL proof and the existing two RPC wrappers.

The writer uses the same fixed PostgreSQL proof on a capture made inside its own
transaction. A new key requires the current affirmative Risk proofs. An exact
key replay reauthenticates the original scope and returns the existing durable
receipt ahead of current Risk admission. The receipt identifies the reservation
and cannot serve as a dispatch permit. The active successor includes one
unreflected quote debit and leaves balances, positions and the ledger intact.
Both operations use the two existing restricted RPC names. The diagnostic
requires a completed Prisma deployment of migration 72. The port supports one direct
successor per execution and exposes no route from the API or dispatch service.

The [private server port](../../packages/paper-engine/src/postgres-postexecution-reservation.ts)
checks a fresh write in the same PostgreSQL transaction. It reruns common
Risk and compares the result with the fixed SQL proof and saved debit. It
applies the exact persisted commitment event through the common Portfolio
reducer and verifies the saved watermark, canonical book and hashes. Any
monetary posting, evidence mismatch or expired certificate causes rollback.
The proof stays inside the port. A successful transaction returns the receipt.
An exact replay or restart read checks the durable receipt and does not
recertify expired or replaced policies. A lost COMMIT gives an uncertain
outcome and leaves recovery to an explicit read by the permanent key.

`capture` may persist only the existing nonfinancial loss checkpoints/certificate.
Exact valid source replay preserves certificate identity, revision and clocks.
`readCurrent` cannot create/renew it. `advanceLoss` exposes bounded durable
progress without a grant. Uncertain COMMIT returns no result; explicit restart
read reconciles the durable nonfinancial outcome. Abort/deadline/physical cleanup
remain bounded; no slot is freed before transport settlement and no blind retry
is introduced.

## Acceptance boundary

Tests cover genuine durable target authentication, count-once semantics, current
rule replacement and retirement, original-reader rejection, conflicting selectors,
extra drafts, pause/permission gates, concurrent capture and lost-COMMIT restart
without additional financial effects. Migration 72 acceptance includes populated
71→72 upgrade/redeploy, readback of the original execution, restricted owners,
compiled reopen, reset and full Ubuntu/Windows/native/Docker/CodeQL CI.

LIVE and financial PAPER dispatch, positive native collateral credit and PHASE 14
remain disabled. Native AMEND remains Binance Spot TESTNET only. Real private
exchange acceptance, crash/backup restore and production soak are not claimed.
