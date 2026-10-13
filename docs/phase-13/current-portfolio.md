# Current PAPER common book source

## Scope and starting checkpoint

Start from protected main **f6c0efc1bd77c5e7bb1e3278e8feff362801f8e3**. PR #12 is merged, full exact-main CI 38356566294 and CodeQL 38356566441 are GREEN: 3501 unit / 41 HTTP per OS, 933 PostgreSQL, 32 bootstrap contracts fresh/non-BYPASSRLS owner, populated 40→41, twelve deployments, audit zero. Published migrations 1–41 and accepted native runtime are immutable. Bootstrap original receipt is historical, not current financial authorization.

This increment is a server-owned read-only current book capture prerequisite, including ordinary unapplied common CREATED/PLACE drafts. It does not implement active holds, Risk admission, liquidity allocation or dispatch. Native Risk/Portfolio guards and old initial/bootstrap ports remain unchanged. A source hash is content identity, not a certificate, permission or freshness extension of the original snapshot.

## Contract

- Separate isolated NOLOGIN source role with one capture RPC; no initializer, funding, table, reservation, credential, Order or native financial grants. Startup and every SQL call reject elevated, mixed, transitive or additional authority.
- Exact server-derived tenant/account/PAPER ownership, null private connection, active verified owner, SIMULATED account/profile and retained original configuration/funding/book seals. No caller balances, state, book ID, epochs, timestamps, model or URL override.
- One bounded READ COMMITTED transaction: GLOBAL shared → tenant exclusive → current owner/account → common book locks. Reread immutable provenance, conserved seed, exact current common book/evidence/outbox, current permission/reconciliation epochs, account version and complete bounded CREATED-draft inventory.
- Return one account-scoped PAPER_BOOK_SOURCE with current capture time, original book/revision/state/snapshot time, current lossless account epochs and draft identities/hash/client IDs. Do not rewrite snapshotAt, receipt, book, evidence, outbox, client watermark or ledger. The source is not a complete tenant-wide Risk inventory.
- No active financial writer exists for PAPER yet. Any pending/UNKNOWN, reservation/decision/attempt/fill/position/other monetary event, hold/watermark, arbitrary/evolved book or missing/conflicting origin fails closed; never reconstruct from seed or silently ignore activity. Future active lifecycle requires a separate accepted writer/provenance contract.
- No return after uncertain COMMIT, abort or deadline crossing; no automatic retry. Four owned physical operations, no hidden queue; slot remains owned until physical close/settlement. Captured asOf must be fresh at the final server return, while original snapshot time remains historical.
- Explicit size/count bounds and lossless money/counters. Additive migration only; published 1–41 unchanged. No changes to accepted Risk/Core/Order/Portfolio/adapters, workflows, dependency lock or LIVE prohibition.

## Acceptance

First native RED creates real configuration, conserved funding, common draft and accepted bootstrap, then requires the absent current-source port. GREEN requires exact scope/provenance, current epochs/draft replacement, unchanged original time/no second effects, current owner/role/seal/corruption/UNKNOWN denial, concurrency/restart, real lost read COMMIT, physical abort/deadline/slot recovery, fresh/non-BYPASSRLS owner, populated published-41 upgrade and compiled deployment proof. Full local regression and complete source/PR/protected-main Ubuntu/Windows/PostgreSQL/Docker/CodeQL acceptance are required. No skipped/cancelled run is acceptance.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**. LIVE/PAPER dispatch/positive native credit disabled. Native AMEND only Binance Spot TESTNET; real private exchange acceptance and production soak not claimed.

## Candidate API and validation checkpoint

The separate @ctp/paper-engine/portfolio subpath adds createPostgresPaperBookSource with read(owner, io) and close only. The isolated ctp_paper_book_source role has only capture_book_source(jsonb); it cannot initialize/fund or directly access tables. Additive 42 must precede this new factory; old ports and native guards do not change.

PAPER_BOOK_SOURCE returns current asOf, original bookId/revision/state/receipt, current account permission/reconciliation epochs/version/client high watermark and numerically ordered lossless common draft IDs/command hashes/client IDs. Its content hash excludes capture time, so a new read of unchanged evidence does not replace content identity or rewrite snapshotAt. This is one account-scoped read proof, not a complete tenant Risk inventory, certificate, permission, reservation or grant.

Both native missing-port RED runs preserve 933 existing passes and one new failure; 38 unit RED→GREEN cases pass. The original sandbox EPERM with zero cases is kept separately. Candidate native acceptance, 37 fresh/owner contracts, populated 41→42, role graph 157 and compiled/full CI remain pending. Full PHASE 13 gate stays NOT READY FOR PHASE 14.
