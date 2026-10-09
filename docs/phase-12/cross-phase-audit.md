# PHASE 4–12 cross-phase hardening audit

## Current completion status — 9 October 2026

The certified PostgreSQL source backend, atomic admission, Portfolio bridge, final current-state dispatch and durable AMEND service/recovery are implemented and accepted on main 1eb1d82. Later accepted source 0b3208dd includes certified CANCEL, one Binance Spot TESTNET native AMEND profile and cross-adapter final-handoff repair; full CI 37904894495/native 37904894325/CodeQL 37904894162 are green. Exact final-main acceptance remains separate. The [final authority review](final-authority-review.md) checks the complete cross-phase chain rather than inferring it from package tests.

The user accepted [conservative collateral](native-collateral-evidence.md) as an explicit PHASE 12 limitation: full local hold remains; positive native credit stays disabled. The unproven monetary projection draft is excluded. Observer/native PostgreSQL regression and full final-source/main CI remain under verification. LIVE is disabled, PHASE 13 not started, current gate NOT READY FOR PHASE 13.

The sections below are historical findings and checkpoints from the audit started on 7 October. Statements about work missing at those checkpoints are superseded by this current status and exact-source chronology in verification.

## Scope and baseline

This audit starts on fresh clean main 09b7be0a256cd4eba9558b5cb6b05fd0904d9e51, fetched on 7 October 2026. Current roadmap and PHASE 12 requirements/contracts/verification/dependencies/README were inspected. LIVE remains disabled and PHASE 13 is not started. Published migrations 1–15 are immutable.

The fresh local baseline passed format/docs/lint/typecheck, 2734 unit / 41 HTTP, build/schema/runtime, eleven clean deployments and a zero-vulnerability dependency audit. Evidence: phase12-cross-phase-baseline-full.json and its per-command logs. Native PostgreSQL/Ubuntu/Windows/Docker evidence for baseline is the complete existing CI 37604704421; it is not acceptance for subsequent changes.

## Confirmed stream defects and repairs

HIGH: healthy stream age exhausted HTX's 256-entry book/trade/private/candle history, and Bybit/OKX's 64-entry order cache retained every terminal identity. Six deterministic RED tests reproduced RESYNC_REQUIRED on otherwise healthy history (phase12-stream-lifecycle-red.json). Two further RED cases reproduced changed private order evidence accepted at equal native time by Bybit/OKX (phase12-stream-lifecycle-equal-time-red.json).

The shared bounded order observation window retains all active/UNKNOWN orders up to its explicit active-pressure bound, plus a separate terminal window. It never evicts an active order. Evicted terminal observations advance a conservative retired-time watermark; an unknown identity at or before that boundary requires reconciliation. This is stream continuity proof, not durable order authority or permanent identity storage. It does not silently accept a replay whose fingerprint was forgotten. Known exact duplicates are ignored; equal conflicts, time/fill regression and terminal-to-active regression reject. Binance/Bybit/OKX use 64 active + 64 terminal slots; HTX uses 256 + 256. Pressure from simultaneous active orders is distinct from elapsed history and still fails closed.

HTX book ordering now retains one lossless BigInt sequence/time/fingerprint. Trades retain at most 256 fingerprints and a retired-time watermark, sort each bounded native batch by native time, and reject an unknown regressed/unprovable replay. Candles retain one current open time/fingerprint/revision/completion; prior open-time evidence requests resync, complete bars cannot change, and healthy advancing open times do not accumulate history. Before-ACK, heartbeat/control, pending private and consumer queues keep their existing bounds. Metadata/permission/source-gap/no-reconnect guards remain in place.

HIGH: Binance's rolling private notification cache accepted conflicting equal-time evidence, and both Spot/USD-M partial book streams silently ignored changed payloads at an equal sequence. Separate RED reports phase12-binance-stream-red-final.json and phase12-binance-book-conflict-red.json reproduce these. Private notifications now use the same order continuity proof before publishing the independently fetched native order. Partial books compare the full native snapshot fingerprint before ignoring equal sequence. Existing lossless ordering/linkage remains unchanged.

Deterministic GREEN covers HTX 10000 book updates, 10000 trades, 1100 open times and 1100 revisions of one partial candle; 1000 terminal identities each through Bybit/OKX/HTX; and 10000 Binance terminal identities. The shared-window test additionally retains an old active order across 10000 terminal identities while asserting bounded counters after every event, and rejects evicted old/equal/conflicting replays. All existing Binance public/private and targeted HTX/Bybit/OKX guards passed. The unified command is pnpm test:stream-lifecycle. Complete local and exact-source CI evidence appears below.

## Confirmed Market Data physical timeout defect

HIGH: worker Promise.race returned RECOVERY_DEADLINE without aborting its underlying metadata HTTP request. A real loopback HTTP socket RED still had one pending operation after timeout (phase12-worker-physical-abort-red.json).

Each metadata/recovery operation now owns a child AbortController linked to worker shutdown and its absolute deadline. Timeout aborts that child; successful publication requires a nonaborted, unexpired operation. The worker waits for actual port settlement, with a 250ms teardown contract. A noncompliant port is retained in tracked pending state, permanently faults the worker and cannot accumulate retries. Maximum simultaneous operations is four; shutdown waits for their settlement within the same teardown bound. Arbitrary injected code cannot be forcibly stopped by JavaScript; compliant server ports must stop I/O and forbid publication after abort. The fault path exposes pendingOperations/unsafePort rather than hiding the violation.

Real metadata and recovery HTTP fixtures each execute three successive hung-request deadlines, observe physical request close, zero remaining operations and no accumulation. Parent shutdown waits for actual port settlement. A deliberately noncompliant port is invoked once across ten rejected retries. Evidence: phase12-worker-all-green.json. This is not proof of a production source collector that does not yet exist.

## Operational evidence and remaining audit work

Read-only GitHub legacy branch protection API returned HTTP 404 / Branch not protected for main on 7 October 2026; the effective branch rules API also returned an empty list. The current account has repository admin permission. Required Ubuntu, Windows and real-services/PostgreSQL/Docker checks and no direct bypass need repository administration configuration; this audit does not claim those protections exist or alter GitHub settings.

At the 7 October checkpoint, registry acceptance preceded the still-pending physical Risk chain and SQL/Auth/units/crash/supply-chain reviews. Those modules were subsequently implemented and accepted as recorded above and in verification. This historical checkpoint was NOT READY FOR PHASE 13; it is not a claim that the current accepted substrate is absent.

## Current local regression

The complete post-fix local regression finished at 12:18:20 UTC, 7 October 2026: format/docs/lint/typecheck, 2758 unit / 41 HTTP, build/schema/runtime, eleven clean deployments and audit with zero vulnerabilities all passed. Core 854 / Binance 608 / Market Data 94 include 24 new tests. No published migration or dependency/lock change; frozen lock SHA256 remains c3e125e7cc261e8a3afe6dfd67271b654a0aa401ccc498d31515145425945cc5. The preceding exploration run failed the two newly added Binance book RED assertions before their repair; it is not acceptance. Evidence: phase12-stream-worker-local-full.json and per-command logs.

Exact source 54275f9c0d70110b7e2d0a87ae08f01cb098a68e passed [CI 37620934161](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37620934161), completed 12:37:37 UTC. All artifacts, SHA, step conclusions, frozen lock and counts were verified at 12:44:21 UTC: Ubuntu and Windows each 2758 unit / 41 HTTP, eleven clean deployments and zero audit vulnerabilities; 393 native PostgreSQL plus three dependency lifecycle tests; Docker smoke PASS, shutdown 314 ms. No cancelled/skipped required job substitutes for acceptance. Evidence: phase12-stream-worker-source-artifacts-verified.json and downloaded artifacts. This accepts the stream/worker fixes, not all remaining PHASE 12 work.

## Runtime registry and metadata boundary work

HIGH: the structural production factory boundary still accepted a finite reference registry; Exchange Core also published events after captured metadata/rules expired, changed or became unavailable. Eight RED assertions precede the runtime changes. The [runtime registry contract](runtime-instrument-registry.md) records the explicit owner boundary, awaitable durable publication, bounded observational projection versus authoritative SQL reads, new additive immutable history/revision schema and complete native/OS/Docker acceptance below.

The registry source 9cd86c34a7b53aedd78cf9b01d140cbfd332f527 now has complete accepted [CI 37629442514](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37629442514): 2776 unit / 41 HTTP per OS, 414 native PostgreSQL including 21 registry cases, eleven deployments, zero audit vulnerabilities and Docker smoke. All artifacts/steps/SHA were verified 13:51:26 UTC on 7 October. The permanent version history retains 108000 identities across 300 instruments/180 refreshes/restart; exact replay, competing publications, uncertain COMMIT recovery and physical lock cancellation passed. The overall Risk chain is still mandatory.

## Cross-package DB physical lifecycle

HIGH: all eight existing Market/Portfolio/Order/Risk PostgreSQL ports could leave a reconnect authentication socket and unsettled operation 350ms after caller abort/deadline. Sixteen real TCP RED cases precede production changes. A shared pre-handshake stream owner adds four physical and four owned waiting acquisitions, with real cancellation and a three-second acquisition cap, preserving existing transaction SQL. Two further RED tests reproduced Market/Portfolio success after abort as COMMIT settled; both now refuse that publication without assuming rollback. Twenty-two targeted GREEN cases include eight-way compatibility, no pg wait queue, physical close, recovery, old-deadline-free idle reuse and post-COMMIT abort. Final local regression passed 2798 unit / 41 HTTP and all checks/deployments/audit. Exact-source native/OS/Docker CI, including two new actual COMMIT response-loss tests, remains pending; the earlier registry run does not accept this increment. Auth SMTP/Redis physical lifecycle and SQL authorization are audited separately; no unsupported equivalence is inferred.

CI 37636380851 subsequently failed with 415 native passes / one fixture assertion failure and two unhandled client errors. The fixture now compares unchanged initial reconciliation ledger rows rather than assuming an empty ledger. A new real TCP RED reproduced absent checked-out pg client error ownership; one bounded listener closes that confirmed failure path without swallowing query rejection. All 23 physical/COMMIT cases passed targeted GREEN. The source is not accepted until the complete follow-up run succeeds.

## SQL startup role graph

HIGH admission gap: older startup guards did not inspect later-phase schemas or restricted grouping-role attributes. Native tests-only CI 37637016327 produced 47 RED / 21 GREEN role cases, including thirteen successful ordinary startups. The catalogue itself passed private PUBLIC EXECUTE, definer search_path, restricted roles and private financial FORCE RLS; the defect is accepting changed runtime authority. Static factory guards now inspect every ctp_* namespace, exact functions, forbidden tables/columns/CREATE/ownership and MEMBER closure while preserving existing public grants. Native CREATEROLE/noninherited SET ROLE cases extend the contract. Complete GREEN and the remaining independent Auth/unit/Risk chain reviews are required before final acceptance.
