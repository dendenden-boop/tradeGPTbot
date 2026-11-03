# Current Risk for a known START

## Scope and status

This candidate follows accepted main `c9cfca8422812ee48888c75465813727b4a90a17` (PR62), with its own [Platform 41676554143](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/41676554143) and [CodeQL 41676554104](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/41676554104). The fresh baseline passes 5,869 unit tests. Published migrations 1–63 remain immutable; additive 64 is not yet accepted. Full candidate regression and CI remain pending.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** Financial PAPER/LIVE dispatch and positive native collateral credit remain disabled. Collateral stays conservative; native AMEND remains Binance Spot TESTNET only. Real private exchange acceptance, database crash/backup restore and production soak are not claimed.

The [known-START source](started-source.md) establishes a current coherent capture but does not re-evaluate current policies, controls or runtime health. The accepted [execution Risk reader](current-execution-risk.md) requires PREPARED and deliberately rejects after START. This increment supplies an explicit readonly path for the actual started state. It issues no grant, permit, START, reservation, liquidity allocation, ledger entry or Portfolio/hold transition.

## Fixed server boundary

`createPostgresPaperStartedRiskSource` is a server-only `@ctp/paper-engine/risk` factory. It is absent from the pure root. A strict `PAPER_STARTED_RISK_CAPTURE` request contains the existing exact admission selector, original preparation/START keys and current permission/session epochs. Caller clocks, source packets, credentials and alternate SQL are rejected.

The port performs one fixed `ctp_paper.reconcile_admission(jsonb)` call on one bounded physical admission transaction. Existing four-slot capacity, physical abort/drain behavior and timeouts remain. It neither invokes mutation RPCs nor automatically retries. A lost COMMIT returns uncertainty and no result; an explicit new readonly recapture is safe.

Request descriptor preflight precedes parsing: 16 KiB, 256 nodes, depth 16 and no arrays. The complete returned packet is bounded to 16 MiB, 400,000 nodes and depth 28 with collection caps, including at most 300 candidates. The original component decoders retain their own tighter limits; an oversized combined or component packet fails closed. Accessors, cycles and unsupported object shapes are rejected before traversal can read their values.

## Current evidence and immutable history

The new private SQL helper first calls the accepted known-START capture, which authenticates current scope/epochs and the actual durable journal under the existing sorted GLOBAL → tenant → account/book/catalog protocol. It reuses that capture and actual START journal directly. No synthetic PREPARED view is constructed and the legacy PREPARED reader remains closed after START.

Under the same retained locks, it reads the actual original issuance, full current inventory and reservation, policies, metadata/market evidence, runtime publication, controls/circuits and genuine cash-loss baseline through the existing authorities. Current-Risk data acquisition reuses the complete accepted acquisition body. Missing or stale evidence, changed metadata, UNKNOWN, inactive reservation, contradictory scope or publication epochs fail closed.

The internal shared evaluator preserves the accepted PREPARED path and its three-argument entry point. A separate internal START path requires the exact validated START journal and economic capture before reusing the same current policy, retained-budget and Risk evaluation. The target remains part of existing liabilities once; evaluation does not reserve again. Original lease expiries and UTC-day/freshness boundaries remain effective.

The wrapper checks capture ordering, identical current server account/configuration context and the minimum of both finite validity bounds. It checks abort/deadline/freshness again after known COMMIT. The immutable `PAPER_STARTED_RISK_SOURCE` contains the actual `started` capture and current `risk` read result. Its hash is correlation content, never authority at a later dispatch. A future financial writer must reauthenticate current storage and re-evaluate Risk/controls/health atomically with one-use execution, shared liquidity and monetary effects.

An updated request epoch alone does not make an old runtime observation current. After a server-owned permission/account revision change, stale observations must still be rejected until the trusted runtime publisher supplies a matching observation. That refresh must not rewrite the historical START receipt or renew its original reservation.

## Storage and compatibility

Additive 64 creates private `capture_started_risk(jsonb)`, preserves the existing reconciliation RPC body as private `reconcile_admission_v63`, and adds a wrapper routing only the new request kind. Old request kinds delegate unchanged. Only the existing two admission RPCs remain executable by the runtime; PUBLIC and runtime cannot execute either private helper/alias. Fixed search paths, UTC and non-superuser/non-BYPASSRLS owner checks remain mandatory. No table or monetary grant is introduced.

Acceptance must prove populated63 → 64 deploy/redeploy preserves all existing rows, function bodies, OIDs, owners and settings apart from the explicit RPC alias/private ACL. Function count changes 236 → 238. Fresh and populated isolated resets verify private ACLs independently of the original START and source proofs. Existing historical62 → 63 counts and acceptance guards remain unchanged.

## RED and current evidence

Tests-first `9344b29` records 25 unit RED and eight real PostgreSQL RED on all 63 published migrations, with full typecheck passing. The factory/helper did not exist and the fixed reconciliation RPC rejected the new request kind. The owned diagnostic cluster stopped; credentials stayed in memory.

The first implementation preserves all 57 old Risk contracts but exposes seven new fixture errors: the actual BEGIN includes its isolation level; immutable raw journals need independent clones for corruption tests; 300 changed holds require a later book revision; COMMIT fault hooks must be armed after the constructor probe; and a clock jump beyond the transport deadline correctly produces uncertainty. Corrected tests preserve the real protocol, original finite deadlines and sanitized retained-budget denial behavior. No production guard is relaxed. The first native64 diagnostic passes seven cases and rejects a supposed successful epoch refresh because its runtime publication is still stale. That positive expectation is withdrawn; native coverage now explicitly requires a current server publication before accepting current Risk again.

There are 27 passing new unit contracts, including 300-candidate accounting, epoch refresh, immutable receipts, policy tightening, pause/health, scope/metadata/UNKNOWN conflicts, no extra writes, uncertain COMMIT, post-COMMIT expiry and untrusted input/accessor rejection. Related prior readers remain green. All eight corrected native cases pass with the same ten-millisecond diagnostic response delay and the cluster stops. This selected-owner Windows diagnostic is not full Linux/native/owner/upgrade/CI acceptance and is not a crash/restore drill.

The harness adds an independent unfiltered eight-case owner process within 90 seconds and places the new native file in the reviewed PAPER tail. The original START process keeps its own database and first physically settled slot. At most two child processes may overlap; final roles wait for all to close. Original 69-case owner, 480-second aggregate and 1,020-second shared budgets remain unchanged. Historical plan fixtures project out only the added file; new contracts verify the complete current plan. Pinned reconstruction verifies every old harness statement, default Risk guard and published SQL body. Full frozen regression, both OS checks, real PostgreSQL owners/upgrades/reset, Auth/Docker, CodeQL/security, artifact digests and protected publication remain required.
