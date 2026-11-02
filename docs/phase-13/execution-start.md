# Durable PAPER execution-start journal — candidate

Starting protected main is `62d627a1f64aa8bc4253be26c36b242f7dd56e9e`,
accepted through PR59 and Platform41461459890 / CodeQL41461460246. A fresh
thirteen-command baseline passes on913 unchanged inputs:5733unit/41HTTP/audit0.
This document specifies an unaccepted PHASE13 increment, not a completed gate.

## Scope and boundary

The journal records one genuine server-time virtual submission for an existing
PREPARED pristine Spot BUY LIMIT/MARKET attempt. PREPARED time cannot substitute
for START time when a later executor calculates latency eligibility. SQL must
validate current retained Risk under the accepted lock order before recording
START. The receipt is historical journal content, not RiskGrant, a financial
transport permit, a fill, liquidity allocation or a ledger/Portfolio write.

No application/worker composition enables PAPER financial dispatch. Common
Order/Risk/native guards remain unchanged. The future financial executor must
authenticate durable START and revalidate current authority under its own atomic
one-use allocation/ledger boundary; replaying this receipt cannot execute money.

## Server API

`createPostgresPaperExecutionStartJournal` is server-only on
`@ctp/paper-engine/risk`. Its fixed existing PostgreSQL transport has bounded
transactions, four pending slots, physical abort/close settling and no mutation
retry. Options and account/tenant selectors come from trusted server ownership;
there is no HTTP endpoint or caller-selected credential/URL path.

`start()` and readonly `read()` take the strict `PAPER_EXECUTION_START` selector:
original `preparationKey`, permanent `startKey`, exact issued admission scope and
current permission/session epochs. IDs, timestamps, policies, Risk results,
snapshots, SQL, receipts and permits are not caller request fields.

Current ownership/authentication precedes every durable lookup. The semantic
key excludes changing authorization epochs. Exact accepted replay returns the
same original receipt after expiry, policy/rule replacement and factory reopen;
it never refreshes authority. Changed semantics for a key or a second key for
the same attempt conflicts. Readonly MISSING creates nothing.

## Atomic source and lifecycle requirements

- Acquire GLOBAL→tenant→user→sorted account/order/book/catalog locks before
  current Risk validation or journal insertion. All pending/UNKNOWN reservations
  and full holds count once. No caller EVALUATED object establishes authority.
- SQL independently checks current policies/limits, ownership/epochs, original
  active reservation/metadata/capability identity, real public evidence and
  liquidity freshness, health/controls/circuits and the original finite deadline.
  Missing, stale, inconsistent or unsupported evidence rejects without START.
- Server SQL derives event UUID/time and the current-validation witness. New
  rows have permanent uniqueness, forced tenant RLS and immutable causal guards.
  Published migrations1–61 are immutable; schema additions must be additive62.
- START and STOP/withdrawal share serialization. After START no old negative
  path may manufacture NOT_SENT or release collateral. Old pristine readers
  fail closed on newly unsupported started history.
- An authoritative existing reservation UNKNOWN projects monotonically onto
  the started attempt through its retained private event/receipt. Full collateral
  remains; no resolution/release API is added.
- Uncertain COMMIT returns no receipt/grant. Recovery uses readonly reconciliation
  and returns historical content only; neither a read nor exact replay dispatches
  anything or resets a one-use boundary. No blind retry or synthetic NOT_SENT.

## Acceptance

Tests-first unit and real PostgreSQL cases must cover permanent replay/conflict,
current policy/rule/control/health/epoch changes, start/stop races, UNKNOWN,
private-role denial, immutable storage, lost COMMIT and actual database restart.
Preserve all old tests and90s/480s/1020s budgets. A separate bounded native fixture
must not silently overload the existing69-case owner process. Full frozen local
regression and Ubuntu/Windows/native services/Docker/CodeQL source/PR/main CI are
required before accepting this increment.

PHASE13 remains IN_PROGRESS / NOT READY FOR PHASE14. Final financial execution,
shared allocation/ledger/Portfolio progression and its one-use permit are still
outstanding. LIVE/PAPER financial dispatch and positive native credit stay off;
native AMEND stays Binance Spot TESTNET only. Real private exchange, crash/backup
restore and production soak are not claimed.
