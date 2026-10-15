# PAPER Risk authority source

## Scope and authority

The server-only `@ctp/paper-engine/risk` export provides `createPostgresPaperRiskAuthoritySource`. Its sole fixed SQL RPC binds an existing immutable common PAPER PLACE/draft, original configuration/funding/book, current durable public snapshot/trade heads and current PAPER policy/control/identity evidence. Callers supply only the exact PAPER owner and durable intent ID; database URL and credentials remain server controlled. The pure package root does not export the factory.

This is read-only target/pristine evidence for a future coordinator. A content hash proves integrity, not provenance after serialization. The result is neither a certified RiskSnapshot nor approval, reservation, Portfolio hold, one-use permit or financial dispatch. Paused controls remain visible as blocked evidence; an order above a captured policy cap can be returned for later evaluation. No admission bypass is created.

## Atomic capture

Additive migration 47 introduces the NOLOGIN capture-only group `ctp_paper_risk_authority` and `ctp_paper.capture_risk_authority(jsonb)`. The runtime login may inherit only that group, schema USAGE and the fixed RPC EXECUTE. Table/column access, financial/initializer functions, mixed role memberships, privileged attributes, CREATE/TEMP and role ownership fail closed. A private invoker helper retains the published-46 capture guards; the existing role/RPC and all published migrations 1–46 are unchanged. PUBLIC EXECUTE is revoked, and the guarded definer uses pg_catalog search_path.

A bounded transaction takes GLOBAL shared → tenant exclusive → user/account/order/book and metadata/public-head locks. Current platform/user policy publishers, control writers and legacy pause/circuit triggers share the advisory protocol, preventing changes until COMMIT. No later catalog SHARE lock is taken on legacy control tables: their BEFORE-trigger ordering would invert the lock protocol. Native contracts exercise both publisher and legacy writers.

The source requires an active verified user, active exact PAPER account with no physical connection, original immutable PLACE command, untouched durable order, current rules and consistent public book/trade metadata. Missing PAPER policy, conflicting valuation asset, stale/GAP/UNKNOWN/unapplied evidence or conflicting ownership rejects the complete capture. DEMO cannot substitute for PAPER. Existing pristine-book guards remain in force.

## Current state and freshness

Platform/user policy heads retain immutable IDs, versions and limit hashes; their intersection uses the common Risk contract. Permission epoch remains a canonical lossless BIGINT string. User session epoch is a canonical string bounded by its actual PostgreSQL INTEGER storage (0–2147483647); account version follows the existing account contract.

Global/tenant control heads retain scope/key/state/epoch and a digest of the exact SQL JSON text. Active legacy tenant pauses and circuit states are included conservatively. Missing global kill head is represented as null with global pause true, without manufacturing a RUNNING epoch. OPEN dominates HALF_OPEN. Native connection controls are not relabelled as PAPER connection evidence.

The stricter model/platform/user evidence age applies to every original publication, receipt and exchange timestamp. The validity deadline is the earliest exclusive deadline; original configuration/model/snapshot timestamps are never renewed. Missing health/capability evidence is not manufactured as HEALTHY or supported.

## Physical lifecycle

The source owns at most four physical sockets, without an unbounded queue. Connect, statement, query and total operation deadlines remain bounded. Abort, deadline or close destroys the owned underlying socket. Only a known successful read COMMIT returns evidence; uncertain COMMIT yields no source and is not blindly retried. Restart reads current durable heads without adding any monetary effect. Post-settlement expiry rejects evidence that aged out while settling.

## Verification and remaining work

Baseline: thirteen existing commands passed at starting main c00807a70a1500b962a3ca5768ed17bbee1a0219. One missing-factory RED precedes implementation. A separate decoder RED reproduces acceptance of session epoch 2147483648 before applying the actual INTEGER limit; the raw 48-pass/one-fail report is retained. All 58 new unit/actual hung-TCP contracts now pass. Source **21052966c3f283846be1031a1c391cd85a430199** passed full [source CI 38777123466](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/38777123466), [source CodeQL 38777123408](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/38777123408), [PR CI 38777132711](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/38777132711) and [PR CodeQL 38777132788](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/38777132788). Exact SHA, artifact IDs, successful job windows and ZIP SHA256 digests were verified: **3918 unit / 803 Paper / 41 HTTP per OS**, **1138 native PostgreSQL**, **36 new capture contracts** fresh and repeated under a non-BYPASSRLS function owner, **192 role-graph cases**, populated published-46→47 and all earlier owners/upgrades, twelve clean deployments, audit zero/no open CodeQL findings. Every required job succeeded without skipped/cancelled substitutes.

The native suite defines 36 capture contracts, repeated under a non-BYPASSRLS function owner, seven added role-graph cases and populated published-46→47 upgrade proof preserving the old RPC definition, original draft/client ID/book and funding entries. Full source/PR Ubuntu, Windows, real-services/Docker and CodeQL acceptance passed with exact-head artifacts; final documentation/protected-main acceptance remains separate. No workflow, case or assertion is removed. The cumulative parent runner adjustment is documented below; every native/SQL/Auth child and individual operation deadline remains unchanged.

This source does not prove all tenant accounts, active orders/UNKNOWN vector obligations, general UTC loss history, current health/capabilities or a complete certified PAPER snapshot. Atomic vector evaluate-and-reserve, durable Portfolio commitments, final dispatch validation and virtual execution remain unfinished. **PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**. LIVE/PAPER financial dispatch and positive native credit remain disabled. Native AMEND remains Binance Spot TESTNET only; real private exchange acceptance and production soak are not claimed.

## Native fixture failure retained

Original source CI 38770620238 passed both OS jobs and CodeQL, then failed the new owner suite (35 PASS / one FAIL): text-name table privilege lookup required public schema USAGE, which the isolated runtime intentionally lacks. The correction checks the catalog OID and also exercises a real permission-denied INSERT. No runtime grant, production source, migration, deadline or contract count changes. The failed report/log/artifact proof is retained; this run is not acceptance. Full corrected-head regression/CI remains required.

## Cumulative parent runner RED

Corrected-head source CI 38772952015 / PR CI 38772961393 passed all 36 owner contracts, populated upgrades and 1138 native assertions (192 role-graph cases), then exceeded the 900s cumulative database parent during later Auth acceptance. Neither failed run is acceptance. Exact-SHA artifact/report evidence is retained. A separate runner RED requires sufficient owner/upgrade/setup room; only that parent changes to bounded 1020s. Native 480s, Auth 120s/180s, per-test/hook 15s/30s, production SQL/abort deadlines and the 20-minute job cap remain unchanged. The contract reserves three minutes inside the job cap for setup/smoke and no assertion or stage is omitted. Full new-head regression/CI is required.
