# Atomic tenant cash Risk context

## CI suite isolation correction candidate

Source e60d3c73b6b269ae430f72f222d59b59298da9c3 [run39012976517 attempt2](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39012976517/attempts/2) completed integration successfully but was cancelled at the unchanged20-minute serial job cap during Docker smoke completion/cleanup. Docker printed PASS, but the cancelled job is **NOT acceptance**. Attempt1's cumulative1020s failure and the independent successful PR run remain historical evidence below. Both failed/cancelled attempts retain raw logs, exact job metadata and artifact/digest evidence; neither is promoted to acceptance. No further unchanged retry is used.

A RED workflow contract precedes splitting the independent, uniquely named/credentialed/ported Compose projects into parallel isolated **Native PostgreSQL and real services** and **Docker smoke** jobs. The existing required context **Real services and Docker smoke** becomes an always-run aggregate gate: only two definitive success results pass; failure/cancelled/skipped/missing/unknown results fail. Native job cap20min, cumulative database parent1020s, native480s, Auth120/180s and test/operation budgets remain unchanged; separate smoke job10min and gate1min are bounded. Existing assertions, commands, image/action/runtime pins, security scans and required contexts remain mandatory. This changes CI scheduling, not financial runtime.

Eighteen gate contracts passed RED→GREEN, including the actual process exit and dependency/budget contract. The41 tenant-source contracts remain. Full local regression and complete new-source/PR/final-head/protected-main CI are required before acceptance. Published1–49 and candidate migration50 bytes, source ports, native Risk/Order/Portfolio/adapters remain unchanged from the tested source. **PHASE13 IN_PROGRESS /NOT READY FOR PHASE14**, LIVE/PAPER dispatch/positive native credit disabled.

## Source attempt1 cumulative deadline — not acceptance

Source **e60d3c73b6b269ae430f72f222d59b59298da9c3**, [CI 39012976517 attempt1](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39012976517/attempts/1), passed Ubuntu/Windows/CodeQL and all1257 native PostgreSQL assertions, including78 restricted-owner authority/context cases and the populated upgrade. Native aggregate **458732ms /unchanged480000ms**. After compiled Auth runtime passed, the unchanged **1020s cumulative database parent** expired. The final database report and remaining Docker completion were not established; this attempt is **NOT acceptance**. Exact-SHA raw logs, artifact IDs, job windows and ZIP SHA256 evidence are retained.

The same source passed full independent [PR CI39012979470](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39012979470):1257 native, all owner/upgrade/Auth/Docker stages and audits0, native aggregate378582ms. One unchanged Real services job rerun is used for source verification; no code/test assertion, workflow or deadline is relaxed. Its complete result must be verified before acceptance. This paragraph is a historical checkpoint, not a claim that a pending rerun passed. **PHASE13 IN_PROGRESS /NOT READY FOR PHASE14**; LIVE/PAPER financial dispatch/positive native credit disabled.

## Scope

`createPostgresPaperTenantRiskContextSource`, exported only by `@ctp/paper-engine/risk`, reads an exact server-authenticated PAPER owner and immutable intent ID through `ctp_paper.capture_tenant_risk_context(jsonb)`. It joins complete retained pristine tenant cash/loss evidence with the accepted target authority/runtime context. No caller inventory, clock, health, policy, database implementation, price or credentials override exists. Server configuration controls the database connection.

This source closes the consistency gap between independent target/runtime and tenant cash reads. It is not a certified RiskSnapshot or financial admission. The existing cash-only/pristine limitation is retained: active orders, UNKNOWN economic effects, reservations/holds, positions, noncash inventory and general post-execution history remain unsupported and reject; no zero loss is inferred for them. CREATED common drafts retain their original identities and are not relabelled as admitted orders.

## Atomic capture and authority

Additive migration **50** creates one isolated NOLOGIN group, `ctp_paper_tenant_risk_context`, with schema USAGE and EXECUTE on this single public capture RPC. It grants no table, financial writer, initializer or earlier source authority. Startup and SQL dispatch enforce the exact role graph, including direct/column privileges, extra/transitive roles, privileged attributes, schema/database ownership and CREATE/TEMP. Private invoker/PUBLIC EXECUTE grants remain denied; definer uses `pg_catalog` search path. Published migrations **1–49** and all earlier functions/grants remain unchanged.

The fixed READ COMMITTED transaction captures inventory first under **GLOBAL shared → tenant exclusive → user/all sorted accounts/orders/books**, then target/current rules/public market heads/policies/controls and the runtime journal. The user/account/order FK locks close retained catalog/economic insertion phantoms; existing writers retain the accepted advisory protocol through COMMIT. Missing or disabled inventory members reject wholly. Up to 100 accounts, 1000 total drafts, the existing 1 MiB cash source and 3 MiB target context bounds, and a 4 MiB combined envelope are retained. No financial/data writes occur.

The private loss invoker preserves the published cash completeness checks while the new wrapper enforces its own session role. Earlier public RPCs are not called with a mismatched runtime login and their guards are not relaxed. Existing private target/runtime helpers retain their accepted checks. Populated upgrade acceptance must preserve every earlier ctp function definition and original ledger/order/book/configuration/funding/runtime row, including repeated migrate.

## Content and freshness

Private decoders validate the two sources independently, then require exact target book content identity: original configuration/funding/sealed state, account epochs/version/client watermark and every CREATED draft. A matching account ID alone is insufficient. All tenant books share the same valuation asset, matching current effective policies. The inventory capture precedes target context; each child precedes the enclosing server capture, which cannot be in the future. Hashes identify content only and do not authenticate serialized evidence.

The exclusive validity deadline is the minimum of target context, cash loss UTC boundary, every original runtime/market/rules deadline, the stricter current policy age and every tenant model age applied to the inventory proof. Reading later cannot renew original facts, the historical seed snapshot or a previous UTC day. Negative runtime/control evidence is retained explicitly without becoming approval. A fresh cash inventory proof does not rewrite its original Portfolio snapshot time.

## Physical lifecycle

The fixed port owns at most four sockets with no unbounded queue. Connect/statement/query/total bounds remain 1000/2000/2500/3000ms. Abort/deadline destroys the underlying socket; slots remain occupied until close. `close()` drains physical work. Only known read COMMIT can return evidence; uncertain COMMIT returns no result and is never automatically retried. After physical settlement, deadline/abort/freshness are checked again. No monetary grant or effect exists to recover from this reader.

## Verification and gate

Starting main **71d7facda2511d8173993d1fd134f6225ed8dada** passed all thirteen baseline commands. One executable missing-factory RED became GREEN. An earlier Windows sandbox EPERM before test execution is a tooling failure, not reproduction. **41 targeted unit contracts passed**: exact composition, conflicting individually valid captures, negative health/controls, strict policy age, UTC midnight, 100-account exact sums, malformed/oversized evidence, fixed RPC/known COMMIT, uncertain COMMIT, post-settlement expiry and actual hung TCP authentication abort/deadline.

Eighteen native contracts cover two accounts/restart/no second financial effect, missing/disabled/noncash/UNKNOWN sibling, missing runtime, permission replacement, lost COMMIT, blocked physical abort/deadline/slots/close, SQL role drift/least privilege, runtime/policy/control writers and account FK insertion. They repeat under the non-BYPASSRLS function owner. Seven role-graph cases, published-49→50 populated upgrade and all earlier assertions remain required. Native and full exact-head CI acceptance are pending until actual results/artifacts are verified. No local native PostgreSQL/Docker execution is claimed.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**. General active/UNKNOWN exposure and economic history, capabilities/certification, atomic vector reservations/holds, final validation, operational sensors/bootstrap and virtual execution remain outstanding. LIVE/PAPER financial dispatch and positive native credit remain disabled; native AMEND only Binance Spot TESTNET. Real private exchange acceptance and production soak are not claimed.
