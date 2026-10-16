# Native acceptance capacity

## Confirmed reproduction

Starting main: **bb5caad21e0c83985134a80d62fd1c0911c1e02e**. Its first [main CI 38860605484](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/38860605484/attempts/1) exhausted the unchanged **480000ms** serial native budget. It printed 1154 passed assertions from 31 of 38 files, but produced no final database report. Ubuntu, Windows and CodeQL passed; the failed native run is not acceptance. Exactly one unchanged-head failed-job rerun subsequently passed 1192 native assertions in approximately 465608ms. That historical success does not remove the capacity problem.

The accepted report shows 23 InstrumentRegistry cases taking approximately 80358ms, including a 78006ms stress case covering 300 instruments, 180 refreshes, more than 100000 permanent version IDs and restart. The case and all its assertions remain unchanged.

## Isolation and lifecycle contract

The private test harness discovers every existing database/auth native integration file. It runs two cohorts concurrently: the complete registry file on a separately migrated database with its own dedicated restricted registry login, and all remaining native files except the runtime role graph on the original fresh database. The role graph runs serially after both processes physically close. This preserves cluster-role mutation isolation. Registry activity probes select by login, making the distinct login necessary even with separate databases.

There is **one 480000ms aggregate deadline** across both parallel processes and the subsequent role graph. No phase receives a renewed budget. Existing per-case/hook/SQL/recovery, Auth, 1020000ms database-parent and 20-minute CI job deadlines are unchanged. Failure, abort or aggregate expiry terminates owned process trees; serial role mutation cannot start after failure. Cleanup is bounded and cannot produce acceptance after expiry. Output remains bounded and credentials are redacted.

Every cohort writes a distinct fresh JSON report. A merger requires the exact discovered file inventory, passed assertions only, unique file/assertion identities, coherent counts and no pending/todo/failure/snapshot work. Missing, duplicate, unplanned or incomplete reports fail closed. Original assertion identities and raw reports are retained; `database-tests.json` remains the combined compatibility report. `database-cohorts.json` records isolation identities, timing and coverage without credentials. Future native files automatically join the main cohort.

Existing owner, populated-upgrade, migration-repeat, Auth hardening/reset and Docker smoke stages remain enabled. Published migrations **1–48**, production packages, adapters, dependency pins and CI workflows are unchanged. This changes acceptance orchestration only.

## Verification and phase boundary

The clean starting head passed all thirteen local format/docs/lint/typecheck/unit/HTTP/schema/build/runtime/clean/audit commands before edits. Two missing-entrypoint contracts then executed and failed (RED). The implemented helper passed 21 targeted contracts, including real owned child/descendant termination, parallel handshake, serial ordering, shared deadline, pre-abort and rejection of incomplete/duplicate/skipped reports. These process fixtures do not substitute for native PostgreSQL proof.

Full changed-head regression and complete Ubuntu/Windows/real-services/Docker/CodeQL CI remain required. No local native PostgreSQL/Docker execution is claimed. Exact CI IDs, merged head and verified native counts/timings are recorded after completion; neither an old green run nor incomplete reports accept this candidate.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**. Certified PAPER capture, atomic reservations/Portfolio holds, final validation and virtual execution remain outstanding. LIVE/PAPER financial dispatch and positive native collateral credit stay disabled; native AMEND remains Binance Spot TESTNET only. Real private exchange acceptance and production soak are not claimed.
