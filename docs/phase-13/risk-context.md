# Atomic PAPER Risk context

## Scope

`createPostgresPaperRiskContextSource` is a server-only `@ctp/paper-engine/risk` reader over the fixed `ctp_paper.capture_risk_context(jsonb)` RPC. It accepts only the exact PAPER owner and immutable intent ID, plus AbortSignal/deadline. Connection credentials/profile are server controlled. It exposes no caller clock, store, health, policy, price or inventory override.

This source joins the accepted [authority source](risk-authority-source.md) and [runtime observations](runtime-observations.md) inside one transaction. It is evidence for later certification, not a certified snapshot or financial admission. The authority source's pristine target/book restriction remains: it does not claim complete tenant exposure, active reservations, UNKNOWN holds, capabilities or loss certification.

## Atomicity and least privilege

Additive migration **49** creates one isolated NOLOGIN group, `ctp_paper_risk_context`, with schema USAGE and EXECUTE on the single capture RPC. Runtime logins must have only this group, no direct table/column authority, schema ownership/CREATE, database CREATE/TEMP, privileged or transitive extra role, or other private RPC grants. Startup and SQL dispatch recheck the boundary. PUBLIC cannot execute the private invoker helpers; only the guarded definer owner uses them. Published migrations **1–48** and their RPC definitions/grants are unchanged.

The transaction acquires the accepted **GLOBAL shared → tenant exclusive → user/account/order/book → metadata/public-head** locks. Policy/control/account writers and runtime publishers use the same advisory protocol; evidence cannot change between the two captures or before COMMIT. Runtime head is additionally locked FOR SHARE. No late control catalog lock or monetary budget write is introduced.

The decoder binds owner/account/PAPER/null connection, external account, client epoch, original complete configuration receipt/hash and current permission/session/account epochs across both sources. BIGINT epochs remain strings. Child capture times must precede the enclosing capture and current server time. Hashes validate content only; serialized/replayed objects do not establish provenance.

## Freshness and physical lifecycle

All nine runtime facts retain their source IDs, statuses and original timestamps. Freshness is the minimum of model age, current effective policy age and 5000ms. `validUntil` is the earliest exclusive deadline across the existing authority/runtime sources and every runtime fact under that stricter age. Later read/capture times cannot renew a fact. Missing/stale/conflicting evidence rejects the entire context. FAILED/UNKNOWN facts and paused/open controls remain explicit negative evidence; a returned context never implies approval.

Four owned physical sockets bound concurrency. Connect/SQL/query/total bounds remain 1000/2000/2500/3000ms. Abort/deadline destroys the owned socket; the pending slot remains occupied until its close event. `close()` drains physical sockets and rejects further reads. Only known COMMIT returns evidence; uncertain COMMIT returns no context and issues no financial grant. The port rechecks caller deadline, abort and source freshness after physical settlement. No automatic read retry or monetary side effect exists.

## Verification and gate

Missing-factory RED and **41 targeted unit GREEN** contracts are retained, including mismatched independently valid sources, original-fact deadlines, UNKNOWN/FAILED controls, fixed RPC/transaction ordering, uncertain COMMIT, post-COMMIT expiry and real TCP handshake abort/deadline. Native contracts cover exact capture, restart/policy refresh, epoch replacement, missing/negative runtime evidence, ownership, pristine UNKNOWN rejection, tighter policy freshness, lost COMMIT, blocked reads/slots/close, SQL role drift and serialization against runtime/policy/control writers. They repeat under the non-BYPASSRLS function owner. The populated published-48→49 upgrade checks every earlier ctp function definition and retained ledger/order/book/configuration/funding/runtime row. Native pass and final CI are pending until exact-SHA artifacts are verified.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**. Complete certification/exposure/loss/capabilities, atomic reservations/holds, final validation, operational sensors/bootstrap and virtual execution remain outstanding. LIVE/PAPER financial dispatch and positive native credit remain disabled; native AMEND only Binance Spot TESTNET. Real private exchange acceptance and production soak are not claimed.
