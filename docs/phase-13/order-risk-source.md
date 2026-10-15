# Server-owned PAPER order-risk source

## Populated-upgrade fixture correction

Corrected source CI 38616675855 and PR CI 38616680633 both passed the 40 public-trade owner contracts and all 19 new order-risk owner contracts, then failed the new upgrade assertion (0 != 1). The earlier upgrade setup performed only findCreate for a missing key, so it had no common draft. These runs are not acceptance; artifact SHA/job-window/digests and actual reports are retained. The fixture now creates a real immutable common PAPER PLACE under published 45, verifies its original client ID, then upgrades to candidate 46 and checks exact durable replay plus missing-market rejection without seed/book changes. Source runtime, migrations, deadlines and workflows remain unchanged. Full new-head CI is required.

## Candidate verification corrections

The first source run 38614215401 failed the existing 300-instrument owner fixture (39 PASS / one 30s timeout). Independent PR run 38614227003 passed that earlier stage, then returned 18 PASS / one failed new source assertion: the common Order Engine fixture is MARKET with native maxPrice 1000, so its conservative .5-unit debit is 500.5; 5.25525 belongs to the separate LIMIT fixture. Neither failed run is acceptance. Original source/migration bytes are preserved. The correction uses the correct immutable MARKET command expectation and batches only administrative metadata setup for the existing 300-instrument test. All 300 instruments, native publish/head operations, restart assertions, three-slot native waves and 30s test / 2.5s I/O deadlines remain unchanged. Corrected full regression/CI is pending.

This candidate starts from protected main **13a23ec72eb80d4ee5a93b03065428b8bdb3f363**. It supplies an atomic read-only prerequisite for certified PAPER Risk: an existing common PLACE intent, its original book/configuration and current durable public book/trade heads. It creates no certificate, decision, reservation, hold, liquidity allocation or dispatch permission. **PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**.

## Contract

`createPostgresPaperOrderRiskSource` is available only through the server `@ctp/paper-engine/portfolio` export. Deployment-owned PostgreSQL credentials select the fixed `ctp_paper_order_risk` authority. A server authenticates and derives the exact PAPER owner before calling `read({owner,intentId},io)`; UUIDs do not prove authorization. Extra request fields, caller commands, clocks, rules, markets, models, backend ports and credentials reject.

One bounded READ COMMITTED transaction locks GLOBAL → tenant → user/account/order, the retained book and metadata/public-head catalogs. The fixed SQL RPC proves the original common PLACE/PAPER_ENGINE command, account/mode/profile/configuration, unchanged pristine book, client ID and command hash. UNKNOWN, applied or unapplied execution evidence, missing/foreign drafts and incomplete origin reject. Only existing CREATED drafts are supported; this is not active-book exposure or loss reconstruction.

The target instrument and rules come from the immutable draft. Both current durable heads must resolve to that exact database instrument/rule, native instrument and configured public source scope. GAP, missing evidence, conflicting records, replaced/inactive rules, invalid trade seals and stale observations reject the whole read. Metadata/head replacements remain blocked through COMMIT. Native revisions/sequences and decimal money remain lossless strings. Capture never renews the historical seed/snapshot time.

The private decoder recomputes the existing PAPER command hash and uses the accepted pure `calculatePaperRiskEnvelope`. The result binds exact original intent/order/client command, current evidence references and conservative principal/per-fragment fee bounds. Its exclusive expiry is the earliest rule or evidence deadline, including native exchange time. A hash proves content only; accepting serialized source objects would not establish authority.

The port owns its socket before connect, allows at most four sockets without a hidden queue, and destroys underlying I/O on abort/deadline/close. Startup connect, SQL/query and total transaction limits remain 1s/2s/2.5s/3s. A lost COMMIT acknowledgment returns no evidence and never retries automatically; read-only recapture after restart has no monetary effect. Deadline/expiry are checked again after physical settlement.

## Persistence and boundaries

Candidate additive migration 46 grants one capture function and schema USAGE to a NOLOGIN group, with no table or financial grants. Runtime role checks occur at startup and inside each capture. Published migrations 1–45, native Risk/Order/Portfolio/adapters, external dependencies and CI workflows remain unchanged. Restore must retain the original configuration/funding/book, common command/event history, rules and public journals together; missing data fails closed.

This source covers one target account/draft. A future certified coordinator must capture complete tenant inventory, valuation/UTC loss, policies, capabilities, permissions, controls and health under its own single coherent transaction; independently combining these read results is not certification. Atomic reservations, active Portfolio holds and virtual execution remain outstanding. LIVE/PAPER dispatch and positive native collateral credit remain disabled; native AMEND is Binance Spot TESTNET only. Real private exchange tests and production soak are not claimed.

## Verification

Before implementation, the public factory contract failed with `PAPER_ORDER_RISK_FACTORY_MISSING` (`undefined` instead of `function`); the raw RED report is retained in the local checkpoint. Initial decoder/source run: 28 PASS. The complete starting thirteen-command baseline passed, including twelve isolated clean deployments and dependency/secrets/supply-chain checks. Native contracts now cover real draft/head capture, no second monetary effect, restart/concurrency, foreign owner/intent, caller override, GAP, rule replacement, stale evidence, UNKNOWN/unapplied execution, physical abort/deadline/slots/close, lost COMMIT and runtime role changes. Fresh/non-BYPASSRLS owner/populated published-45 upgrade and full exact-head CI acceptance are pending; no acceptance is claimed by this candidate document.
