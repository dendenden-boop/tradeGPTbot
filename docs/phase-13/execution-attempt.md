# Pristine PAPER attempt content protocol

## Accepted baseline and scope

Starting protected main is **d86424f35472cf4432262f2ffe10deed1d701dd3**, [PR48](https://github.com/dendenden-boop/tradeGPTbot/pull/48), complete [Platform40502819971](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40502819971) / [CodeQL40502819965](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40502819965). All eight Platform jobs and CodeQL passed: 5,221 unit / 1,724 Paper / 41 HTTP per OS, 1,384 PostgreSQL / 42 files, nineteen owners, 29 native report sets, original Prisma/upgrade/reset/Auth/Docker, twelve clean deployments and audit zero. Six actual artifact digests/windows and strict protection were verified. All 58 migrations are now published and immutable. This completes the preceding source-publication requirement; earlier checkpoint failures remain historical.

A fresh thirteen-command baseline completed **2026-10-27T12:48:22.162Z** on that unchanged main: 5,221 unit / 41 HTTP, twelve clean deployments, all audits zero and all 844 tracked hashes retained. No accepted financial runtime, adapter, policy, database authority or published migration is changed by this increment.

The [execution source](execution-source.md) deliberately exposes `admittedAt`, not a fabricated submission time. The pure attempt protocol connects an eventual original durable START to the existing latency/competition calculation. It adds `preparePaperExecutionAttempt`, `reducePaperExecutionAttempt` and `projectPristinePaperExecutionAttempt` to the calculation entrypoint. It creates no database attempt, current-policy certificate, one-use permit, positive acknowledgement, fill, allocation, ledger posting, hold transition or dispatch.

## Identity, ordering and time

Preparation accepts a strict original admission descriptor: exact PAPER/null-connection/Spot/SIMULATED binding, original order/intent/decision/reservation and DB instrument/rule UUIDs, lossless signed64 positive admission sequence, original PLACE command/hash, historical admission/expiry and the proposed attempt UUID/preparation timestamp. Current support matches initial Spot BUY MARKET/LIMIT with base quantity, without trigger, reduce-only or POST_ONLY. The command hash must match the original `createOrder` command plus binding. That hash and the request hash are ordinary correlation/integrity checks; coherent caller JSON can never authenticate source or storage.

`preparedAt` must lie within the historical admission window. It does not mean I/O started. Revision1 PREPARED has `startedAt: null`. The descriptor and original clientOrderId remain immutable through every transition. A new attempt UUID cannot mint another clientOrderId, intent, priority or economic fill identity.

| Previous phase      | Event                                                               | Result                                                                 |
| ------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| PREPARED, revision1 | START inside the original admission window                          | STARTED, revision2; `startedAt` is exactly event time                  |
| PREPARED, revision1 | NOT_SENT with CONTROL/DEADLINE/AUTHORIZATION/RULES/HEALTH/CANCELLED | terminal NOT_SENT, revision2; no known start and no collateral release |
| PREPARED, revision1 | UNKNOWN / AMBIGUOUS_START_COMMIT                                    | terminal UNKNOWN, revision2; start time remains unknown                |
| STARTED, revision2  | UNKNOWN / AFTER_START                                               | terminal UNKNOWN, revision3; original known start retained             |
| Any phase           | exact duplicate of its last event                                   | ignored, identical state                                               |

No other transition is supported. In particular STARTED cannot become NOT_SENT, and UNKNOWN cannot become PREPARED/STARTED/NOT_SENT or a positive result. ACK/FILLED/RESOLVE events are unsupported. Event IDs cannot reuse preparation/current-event IDs; expected revisions and timestamps must agree. Different events may share a millisecond only when revision provides their strict order. Equal-revision conflicts, stale/gapped revisions, backward time and torn state reject. This is a finite pristine protocol, not an unbounded lifecycle/version registry.

Historical approval expiry cannot retroactively mean a known START never happened. NOT_SENT or ambiguity may be observed after expiry; only START itself must fit its original window. Exact last-event replay survives JSON roundtrip without allocating another identity. JSON roundtrip is content verification, **not PostgreSQL restart/persistence evidence**. The future writer must retain permanent unique request/event keys and the complete original journal; a deserialized state or matching hash cannot replace that journal.

## Projection and authority boundary

Projection accepts only a valid known STARTED state observed at or after its original start. It returns the unchanged order, original orderId and lossless priority, `submittedAt = startedAt`, and initial `executedQuantity: 0` / `triggeredAt: null`. PREPARED, UNKNOWN, NOT_SENT, a future start or caller-added partial history rejects. Existing simulation still requires public book/trade evidence at or after latency eligibility; historical pre-start evidence cannot manufacture a price. Projection after historical grant expiry is data, not a renewed grant.

The projection is for a **proven pristine, unconsumed history only**. Replaying it cannot reset durable volume, depth usage or executed quantity. The fixed future SQL writer must read original issuance and the complete authoritative attempt/fill/allocation/Portfolio/hold journal, verify server ownership and authentication epochs, enforce permanent replay, and atomically reread current policies/state/rules/capabilities/controls/circuits/health/deadline at one-use handoff. All timestamps must come from trusted storage/clock there. START must describe that final boundary, not an earlier preparation or an intention to call transport. Ambiguous START COMMIT must be reconciled, with no dispatch based on an uncertain result and no blind retry.

No persistence, worker or financial gateway calls these helpers in this increment. Public financial writers and native Order/Risk contracts retain their existing rejection boundaries. No callback, endpoint, SQL handle, credential, permit or caller-produced fill is accepted. Bounds reject arrays/accessor properties, cycles, excessive depth/nodes/strings before canonicalization; output is deeply immutable.

## Verification and gate

Tests-first **bbe6eaa** recorded **81 missing-contract RED cases**. Initial implementation passed all81. Additional preflight RED reproduced traversal of an unexpected large collection and accessor before field rejection (**82 PASS / 2 FAIL** of84). The bounded JSON preflight makes all84 GREEN without invoking the poisoned members. An initial full typecheck also caught one invalid-fixture cast; the test now explicitly crosses `unknown` when constructing deliberately invalid state. Further cases cover excessive depth and post-start UNKNOWN replay beyond historical expiry; the complete current selection passes **86/86**, full typecheck/targeted lint/docs checks pass. Full new-head regression/CI remains mandatory.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** The durable attempt journal, authoritative final gate/permit, atomic shared execution/allocation/ledger/Portfolio/holds, executed/partial/UNKNOWN resolution and remaining operational composition/exits/reset are still required. LIVE/PAPER financial dispatch and positive native credit remain disabled; native AMEND remains Binance Spot TESTNET only. Real private exchange acceptance, database crash/backup restore and production soak are not claimed.
