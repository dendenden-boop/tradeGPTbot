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
- This first positive journal path requires the earliest retained contender and
  a complete PREPARED inventory. It does not skip an earlier/missing contender or
  extend the old pristine readers to started/partially executed accounts.
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

Local candidate checkpoints (not CI acceptance):32 unit contracts reproduced
the missing factory before implementation and pass afterwards. Nine real native
cases reproduce `PAPER_ADMISSION_INPUT` on populated published61, then all pass
after additive62 under a NOBYPASSRLS DDL owner. The local upgrade check retains
all125 prior table inventories and225 function definitions/settings; only the
four renamed private aliases intentionally lose runtime EXECUTE. A separate
clean PostgreSQL stop/start retains all six START rows byte-for-byte and returns
the same receipt through restricted readonly reconciliation. This is a clean
restart diagnostic, not crash/backup recovery or a complete owner-topology test.

Five tests-first cohort cases now pass with the separate serial execution-start
process after both old admissions and before role mutation. Existing cohort
tests pass; the old69-case source and90s/480s/1020s budgets are retained. Full local
unit regression passes5778/5778 after allowing actual loopback sockets. The
earlier restricted-sandbox run failed258 tests with network errors including
`connect EACCES 127.0.0.1`; that failure is retained, not relabelled as a pass.
Full frozen regression, real Prisma deploy/redeploy/reset and remote CI remain
pending for this candidate. No READY gate is granted by these local diagnostics.

The later frozen `4399e0d` checkpoint passes all13 commands on926 unchanged
inputs:5778unit/2154Paper/41HTTP,12 clean deployments and audit0. Its source
[Platform41500706735](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/41500706735)
and PR60 [Platform41500896044](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/41500896044)
are **not accepted**: the isolated Auth proof fails the new reset owner assertion
after its genuine compiled runtime and load/fault checks pass. Source/PR Ubuntu,
Windows and both CodeQL workflows pass; source migration-owner acceptance passes.
These positive jobs do not waive the failed aggregate.

Tests-first `62aaa82` reproduces the harness defect with2 RED/3 PASS cases. A
shared fresh reset runs administrative migrations and proves storage; it is not
the independent NOBYPASSRLS owner project. Proof callers now explicitly choose
`STORAGE_ONLY` or `REQUIRE_NON_BYPASS`. Forced RLS, complete private-function
inventory and all ACL/trigger checks remain mandatory in both scopes. Dedicated
owner and populated-upgrade callers still reject superuser/BYPASSRLS owners;
missing or unknown scope rejects. All5 new contracts and30 targeted regressions
pass. Fresh real PostgreSQL independently verifies all three scope outcomes and
passes all9 native scenarios. The new-head full regression/CI remains pending;
no runtime, migration, deadline or owner acceptance requirement is relaxed.

The corrected `142d6e9` frozen checkpoint passes13 commands on927 unchanged
inputs:5783unit/2154Paper/41HTTP,12 clean deployments,audit0. Its PR60 Platform
workflow passes all8 jobs, including1409 native cases/43 files and20 owner suites.
Source attempt1 is cancelled at the shared-window job despite all9 successful
steps, including window creation and cleanup; the cause is unknown. Its native
jobs are skipped, so it is not acceptance. Four available ZIP sets and raw
metadata/logs are retained. One qualified full source attempt2 uses the same
source/checks/deadlines with a fresh shared window; no partial attempts are
combined into a positive result.

Workflow success also does not satisfy the separate required Advanced Security
CodeQL check. Alert[11](https://github.com/dendenden-boop/tradeGPTbot/security/code-scanning/11)
reports high `js/incomplete-sanitization` in the test-only history mutation
fixture's first-newline replacement. Both rejected candidates retain this
security failure and SARIF evidence. Tests-first `5a31aa9` records a RED guard.
The fixture now constructs the same single marker-body insertion with an explicit
boundary index and slices, preserving its remaining bytes and mutation probes.
All14 targeted tests pass. No runtime/SQL, scanning rule, query, suppression,
source-path exclusion or alert status is changed. New-head full regression,
both ref-qualified zero-alert results and a successful separate security check
are required before this candidate can be accepted.

## Reviewed cohort and fresh setup candidate — 3 November 2026

Source41504065585 attempt2 remains **FAILED**: the main986, registry23, original
PAPER69, native-admission95 and new START9 cases complete, but the final roles
process reaches the unchanged480-second aggregate deadline. Its role report is
incomplete; this is not a1409-case acceptance. All six attempt2 ZIP sets/raw logs
are preserved, separately from the earlier cancellation. No further unchanged
retry is used. The independently passing PR cohort takes469472.622346ms within
480000ms; that result does not waive the failed source.

Tests-first `09ee37b` records nine RED overlap/setup contracts. A supplementary
first-slot contract records7 RED/1 PASS before implementation. Reviewed overlap
is explicit; the legacy serial planner remains the default. Both initial shared
role-mutator processes must physically close first. The new START process owns
an independent eighth fixture database and may reuse the first physically
settled admission slot. At most two children run, the roles process waits for
every child to close, and the original480s aggregate/1020s shared/90s owner
limits remain. Six native/helper input fingerprints and a no-cluster-role-DDL
check guard this opt-in. The original69-case source and all prior cases remain.
The isolated START database must contain real START rows before its own
drop/recreate, two actual deployments and empty forced-RLS/private-ACL checks;
this introduces no application Paper reset.

The new fixture reuses the accepted three-lane all-settled helper for actual
readonly constructors and independent setup. Genuine funding precedes DRAFT;
the complete DRAFT and all setup operations precede book initialization. The
first early-market candidate is rejected by6 of9 actual native scenarios with
`PAPER_ADMISSION_EVIDENCE`; its raw report/stopped cluster remain retained.
A further RED contract requires market publication after book/runtime context
and immediately before admission. The corrected fresh PostgreSQL diagnostic
passes all9 cases with unchanged freshness/expiry checks. Actual configuration
heads remain platform version1/global epoch2: every setup reads current durable
config, identical configured heads need no new publication, and no Risk result,
receipt, clock or financial effect is cached. Missing/invalid control evidence
fails. Ninety targeted contracts, typecheck and lint pass; full new-head
regression/CI and CodeQL11 closure by new analysis remain pending. Runtime,
SQL, published migrations, workflows and security rules are unchanged by this
fixture/scheduler correction.

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
