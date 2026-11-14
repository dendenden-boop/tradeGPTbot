# Admission fixture setup hardening

## Published main and RED reproduction

PR73 was merged by an ordinary protected squash for explicitly approved
`3ab47e8bd15161058525d274ea54906c1f59b546`. Main
`525aaac27ce48ebc75e60b7f839966633de84048` has exactly that tree and previous
main455f8929 as its single parent. Its own
[Platform43622417471](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43622417471)
is RED; [CodeQL43622417535](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43622417535)
is GREEN. This main is **HOLD**, not accepted through the earlier source/PR CI.

Ubuntu, Windows, Auth and Docker pass. The general native job passes1,520
PostgreSQL cases in49 files, including all41 writer/capture cases, both current
Risk upgrades/reset/restarts and secondary cleanup. Its native aggregate is
458.757 seconds under the unchanged480-second cap. The separate owner job
fails its existing90-second admission-suite command deadline after67 of69
cases report PASS, with85.790 seconds of completed case durations. Its admission
report and the remaining owner suites are absent; they are not counted as PASS.
All six actual ZIP digests/producer windows and both raw native logs are retained.

The setup performs an unnecessary immediate configuration replay:
`tenantReady → fixture(configure:true) → configuration.register`, then
`fundCash → configuration.register → funding.initialize`. Neither registration
is an asserted idempotency exercise; every new tenant uses a new configuration.
Tests-first `ea3372fbe1b2a929da226fcd40fbeb6d2ad4b030` adds a deterministic
contract executing the actual setup function with two independent fixture scopes.
It reproduces two configuration registrations where one is required: seven old
contracts PASS, the new contract RED. No native runtime or assertion is changed
by that tests-first commit.

## Minimal fixture correction and invariants

Only the tenant setup call uses the existing `configure:false` fixture option.
The unchanged `fundCash` still performs the real current configuration
registration before actual funding. No registration receipt, current query,
authorization, Portfolio content, Order command or admission result is cached.
Each independent fixture registers its own configuration once. Funding must
settle before draft creation and public price timestamps/publication; book
bootstrap still waits for every genuine lane. Failures drain the existing
operations without returning partial authority.

The parallel-worker input fingerprint is explicitly renewed for this exact
fixture change. A private reconstruction verifies the complete published525
predecessors of the fixture, scheduler and review hook; older immutable hashes
and tamper checks remain. The existing diagnostic error contract is retained.
The first targeted attempt exposed that error-alias mismatch; its correction
retains the old assertion, rather than changing its expected error. All48
targeted setup/review/lifetime/barrier contracts subsequently PASS.

All69 native admission case bodies, production runtime, migrations1–70,
authentication/risk/financial contracts, IO freshness/deadlines, role isolation,
owner counts and90/480/1020-second budgets remain unchanged. No workflow,
security query, source exclusion, administrator enforcement or permission is
relaxed. The correction removes redundant fixture work; it cannot guarantee a
future CI duration or substitute for complete native owner acceptance.

## Acceptance boundary

The published-main RED remains historical evidence. This source candidate needs
the complete frozen local regression and independent full source/PR CI, including
all69 admission cases and all24 owner suites within their original deadlines.
Protected publication requires separate exact-head consent and its own full
main CI. A partial report, successful general native job or earlier GREEN cannot
replace those checks.

**HOLD / PHASE13 IN_PROGRESS / NOT READY FOR PHASE14.** Financial PAPER/LIVE
dispatch and positive native collateral credit remain disabled; native AMEND
stays Binance Spot TESTNET only. Real private-exchange acceptance and production
soak are not claimed. This task adds no financial/runtime feature.
