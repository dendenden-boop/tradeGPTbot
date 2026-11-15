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

The subsequent frozen92f5408 regression completes all thirteen commands:
twelve PASS, unit6,499 PASS / one historical scheduler-fingerprint FAIL.
Its unchanged1,077-file snapshot and all command results are retained. The
older seed-review test must first reconstruct the same explicitly reviewed
fixture fingerprint before applying its existing historical normalization.
Its expected `eb202513` predecessor hash and original assertions are preserved;
the additional review also reconstructs the complete prior seed-test file.
All57 targeted setup, lifetime, seed and tamper contracts then PASS. This fixes
the review composition; the failed full regression is not relabelled GREEN.

## Acceptance boundary

Code checkpoint `4a2de4ca9a5cad526cc9eb46f5081b8389312206` completes all13
frozen local commands on1,077 unchanged inputs: 6,501 unit / 2,537 Paper /
41 HTTP, twelve clean deployments and audit zero. All6,495 prior unit cases are
retained. Its own [source Platform43701732093](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43701732093)
and [PR Platform43701809613](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43701809613),
[source CodeQL43701732068](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43701732068)
and [PR CodeQL43701809648](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43701809648)
are GREEN. All24 owner suites and all69 admission owner cases pass. Admission
owner duration is56.269/54.213 seconds for source/PR under the unchanged90-second
cap; native aggregate364.460/310.074 seconds remains below480. These are measured
results, not future timing guarantees.

Both actual artifact sets verify1,520 PostgreSQL cases/49 files and41
writer-capture cases, preserving every prior native case and all45 report copies
per run. All12 ZIP digests/producer windows and four raw native logs verify.
Upgrade/redeploy/reset, compiled restart, three secondary resets and cleanup
pass. All70 migration files,226 TypeScript runtime files and18 package/lock/
workflow files remain unchanged; exact predecessor reviews preserve all native
case bodies and original setup assertions. No migration or financial feature is
added. The final documentation-head source/PR checks remain separate requirements
from this code checkpoint. Main525aaac is still HOLD until a separately approved
protected merge and successful own-main acceptance.

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
