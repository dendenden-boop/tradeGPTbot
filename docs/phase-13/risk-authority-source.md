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

Baseline: thirteen existing commands passed at starting main c00807a70a1500b962a3ca5768ed17bbee1a0219. One missing-factory RED precedes implementation. A separate decoder RED reproduces acceptance of session epoch 2147483648 before applying the actual INTEGER limit; the raw 48-pass/one-fail report is retained. All 58 new unit/actual hung-TCP contracts now pass. Native/full CI acceptance is pending, not implied by local unit success.

The native suite defines 36 capture contracts, repeated under a non-BYPASSRLS function owner, seven added role-graph cases and populated published-46→47 upgrade proof preserving the old RPC definition, original draft/client ID/book and funding entries. Full Ubuntu, Windows, real-services/Docker and CodeQL acceptance must pass with exact-head artifacts before merge. No workflow or test budget is weakened.

This source does not prove all tenant accounts, active orders/UNKNOWN vector obligations, general UTC loss history, current health/capabilities or a complete certified PAPER snapshot. Atomic vector evaluate-and-reserve, durable Portfolio commitments, final dispatch validation and virtual execution remain unfinished. **PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**. LIVE/PAPER financial dispatch and positive native credit remain disabled. Native AMEND remains Binance Spot TESTNET only; real private exchange acceptance and production soak are not claimed.
