# Native CI proof isolation

This is PHASE 13 acceptance infrastructure only. It adds no financial runtime,
permission, migration or dispatch capability. Default `full`, legacy
`--database-only` and explicit `database` runs retain their complete serial paths.

## Reproduction

[PR45](https://github.com/dendenden-boop/tradeGPTbot/pull/45) was normally merged
with explicit human approval into **44d8ce5a068afc24250bf14aa544f559b9fe601a**.
Source [40347339442](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40347339442)
and PR [40347352019](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40347352019)
passed, but exact-main
[40351817958](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40351817958)
failed at the unchanged **1020000ms** parent command deadline. All 1,378 native
tests in 42 files and all 19 owner reports finished; the cohort aggregate took
447466.126709ms, below its unchanged 480000ms limit. Final database reset/deploy
did not finish, and `database.json` was absent. The aggregate correctly failed.
Ubuntu, Windows, Auth, Docker and
[CodeQL40351817886](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40351817886)
passed. Those successes do not constitute main acceptance.

Owner/prelude and cohort stages both slowed on the actual-main runner. Simply
repeating unchanged source, raising budgets or omitting the reset tail is not
acceptance. Tests-first **077374f** recorded 13 failed / 2 passed contract cases:
missing scopes, missing shared window and a gate accepting results without an
owner job. The two passing cases already rejected unspecified partial evidence.

## Contract

CI creates one immutable wall-clock window with **1020000ms** allowance, bound to
the actual GitHub run ID, attempt and tested commit. Two independent GitHub VMs
receive that same window. Queueing, checkout/build, Docker startup, proof and
cleanup consume it; the second group gets only its remaining time. Missing,
modified, future, expired or differently scoped windows fail closed before SQL.
There is no fresh 1020-second allowance for the second group.

`owners` executes the unchanged original SQL prelude, all **19** restricted-owner
suite commands/assertions and all original populated upgrades. It emits
`PARTIAL`, with owner suites `COMPLETE` and cohorts/reset explicitly `DELEGATED`.
It does not claim the omitted reset tail passed.

`cohorts` executes the unchanged SQL prelude and populated upgrades, delegates
only the 19 owner repetitions to the other VM, then runs all native cohorts and
the original populated admission reset/redeploy and main database reset. Its
report is also `PARTIAL`; owner-suite acceptance is explicitly `DELEGATED`.
SQL owner assertions outside the delegated block remain. No SQL roles or DDL
are shared between these physically separate clusters.

The original **480000ms aggregate cohort** and **90000ms owner process** deadlines,
test/SQL/abort deadlines, cohort overlap barriers and worker caps remain. All
57 published migrations and runtime files remain unchanged. A reconstruction
test removes only explicit partition controls and reproduces the complete old
runner and legacy proof contract, retaining their original hash assertions.

The existing required **Real services and Docker smoke** context now requires
both native groups, Auth and Docker success. It downloads both native artifact
sets and validates actual partial integration/database reports, distinct owned
projects, exact common window and completion inside its deadline. It also
requires all 19 passing owner JSON reports, at least the existing 1,378 native
assertions/42 files, all five settled cohorts and the reset result. Missing,
stale, conflicting, skipped or failed evidence cannot produce acceptance.
The gate itself may read completed evidence after the window closes; all proof
and cleanup timestamps must be inside the original window.

## Verification boundary

Targeted evidence includes a real gate child process accepting complete isolated
artifacts and rejecting an incomplete reset; a hung child is killed using only
the remaining common budget. Synthetic unit artifacts test validation, not real
PostgreSQL privileges. Full local regression, fresh source/PR CI, protected
publication and exact-main CI remain required. No repaired CI result is claimed
until it actually completes.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** LIVE/PAPER financial dispatch
and positive native credit remain disabled; native AMEND is Binance Spot
TESTNET only. Real private exchange acceptance, crash/backup restore and
production soak are not claimed.
