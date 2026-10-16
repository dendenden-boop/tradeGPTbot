# PAPER runtime worker

## Scope and authority

`createPostgresPaperRuntimeWorker` is a server-only `@ctp/paper-engine/runtime` export over the accepted fixed PostgreSQL collector. Construction opens that collector and returns an idle worker; only `run(shutdownSignal)` starts collection. The pure root and private source subpaths expose no worker factory/core. There is no reference-store default, injected collector/clock, HTTP endpoint, financial writer, Risk certificate, approval, reservation, hold or permit.

The server supplies an immutable startup inventory of one to four distinct exact PAPER accounts, all nine explicit exclusively owned probe ports, server-controlled database/profile settings and an integer `intervalMs` from 100 to 1000. Duplicate account IDs, even across conflicting tenants, invalid modes, unknown fields and probe shortcuts reject construction before I/O. The fixed collector retains database URL/TLS and role admission. Failed construction does not acquire pre-created ports.

Account UUIDs are not authentication. Inventory belongs to trusted server startup configuration, never an HTTP request or serialized health payload. Existing SQL independently verifies current active verified ownership and sealed configuration on each cycle. No account-discovery grant or dynamic tenant queue is introduced. Actual application bootstrap, authenticated operational sensor acquisition and production supervision remain outstanding. Missing executor/sensors must use explicit UNKNOWN evidence; no positive test fixture is an operational implementation.

## Scheduling and bounded state

`run(signal)` may execute once. Each account has one sequential loop: acquire fresh facts using the existing collector, await the result, then wait the configured interval. There is no `setInterval`, overlapping cycle, catch-up batch, automatic restart or queue. At most four collection calls and four delay timers exist. Each cycle has the collector's unchanged total 3000ms deadline, further limited by context expiry. Intervals are not a freshness SLA: slow acquisition or stopped workers cause original evidence to expire and readers fail closed.

The worker retains no history of PUBLISHED receipts. Its bounded report retains at most four exact original uncertain publications. Restart means constructing a new worker: each new collection rereads the durable journal head/CAS revision and acquires new facts, without resetting revision or reusing earlier observations. Published migrations 1–48, permanent publication IDs, seals, RLS, lock ordering and version anti-reuse remain unchanged.

FAILED/UNKNOWN health facts are published unchanged. PUBLISHED means a journal commit; RUNNING means a scheduler is active; STOPPED means its normal shutdown completed. None proves service health, complete evidence, certified Risk readiness or permission to dispatch.

## Group shutdown and ambiguity

The lifecycle is IDLE → RUNNING → STOPPING → STOPPED/UNCERTAIN/FAILED. A pre-aborted signal samples nothing. A second run, including after termination or close, is rejected. Closing an idle instance starts no work.

The first collection error or UNCERTAIN result aborts the entire group, initiates physical collector close immediately and prevents future ticks. Concurrent calls must settle before the terminal report; all their original UNKNOWN outcomes are retained, including those caused by group shutdown. Uncertainty takes precedence over a definitive failure. No publication, sample or reconciliation is retried automatically. A definitive error does not erase another account's ambiguous dispatch.

The immutable terminal report contains `state`, `uncertain`, `collectionFailed` and `closed`. Private error details are not copied into it. `closed: true` means physical collector closure succeeded, not database health. Close failure keeps `closed: false` and preserves every uncertain publication. `close()` is idempotent, cancels owned delay timers and operations, waits for physical drain within 3000ms, and rejects with WORKER_CLOSE_FAILED if closure cannot be proved. Late physical settlement cannot reopen this instance. Arbitrary broken JavaScript is not claimed forcibly terminated; the production collector independently retains its slots until underlying work settles.

The supervisor must retain originals returned in `uncertain` and explicitly reconcile them using a fresh fixed collector, without replacing IDs, renewing facts or dispatching a retry. As in the collector contract, process loss can leave no caller-held original; committed journal events/heads remain durable and a later independent cycle samples new facts. That does not resolve a missing caller result. This observation-only API must not be reused for Order/Risk financial recovery.

## Verification checkpoint

Starting protected main **9081c66c197661319a1ab7bf904770415b5265c8** passed all thirteen baseline commands before implementation. Three executable missing-worker RED contracts became GREEN. The targeted suite passed **48 new unit contracts**, including four-account UNKNOWN salvage, failure/abort ordering, non-overlap, 300 successful cycles, immutable inventory, one-shot admission, failed/hung close, negative executor, export isolation and strict options/URL/TLS validation. Initial optional-`io`/UUID-fixture TypeScript repairs are tooling/type issues, not runtime RED.

Four native PostgreSQL contracts are added to the existing runtime suite and repeated under its restricted non-BYPASSRLS owner: periodic publication/restart with negative executor and no monetary writes; real lost COMMIT with one original reconciled event and no retry; epoch replacement during probes; and physical abort of blocked head acquisition without future ticks. Native results and full new-head local/Ubuntu/Windows/real-services/Docker/CodeQL acceptance remain pending. No local PostgreSQL/Docker execution is claimed.

No published migration, native Risk/Order/Portfolio/adapter, dependency, workflow or deadline is changed. **PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**. Actual sensor/bootstrap composition, complete certified capture/exposure/loss/capabilities, atomic vector reservations/Portfolio holds, final validation and virtual execution remain outstanding. LIVE/PAPER financial dispatch/positive native credit disabled; native AMEND Binance Spot TESTNET only. Real private exchange acceptance and production soak are not claimed.
