# Current durable-order Risk source

Verified code checkpoint: `764d773eaa0a3fa01d9d77e220ade37caed66eea`. All13 local commands and complete [source Platform43815054605](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43815054605) / [PR Platform43815060638](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43815060638), both CodeQL workflows and all19 checks pass. Evidence verifies6,602 unit per OS,1,528 PostgreSQL,24 owners,49 writer/capture cases, migration71 populated upgrade/redeploy/reset/compiled restart,twelve clean deployments and audit0. Twelve ZIP digests/windows, four raw native logs and prior case identities verify. This reporting HEAD still requires independent full CI and protected publication; main116c9b0 is unchanged. The increment issues no financial authority; full PHASE13 acceptance remains outstanding.

Status: PHASE 13 candidate, **IN_PROGRESS / NOT READY FOR PHASE 14**.
Starting accepted main: `116c9b0615779a84c5c354fbb381c4ce1a8815bd` (PR75).
This increment supplies server-owned capture/evaluation for a second untouched
durable intent over the accepted single-execution book. It does not implement
atomic postexecution admission, reserve funds, issue a Risk grant or dispatch.

## Request and authentication

The server-only `@ctp/paper-engine/risk` entrypoint provides
`createPostgresPaperCurrentOrderRiskSource(options)`. Its fixed `capture`,
`readCurrent` and `advanceLoss` methods use the existing bounded admission
database transport and restricted `ctp_paper_risk_admission` role. Neither a
backend/SQL callback nor caller command, certificate, clock or role is accepted.

The strict request contains exactly `kind: PAPER_CURRENT_ORDER_RISK_CAPTURE`,
`source` (the existing six-field `PAPER_CURRENT_RISK_CERTIFY` selector for the
original execution) and `target: {orderId, intentId, commandHash}`. Method names
select the fixed SQL operation; callers cannot supply a different operation or
evidence graph. Exact tenant/account/PAPER/profile, user-session and permission
epochs remain mandatory. Returned JSON is evidence content, never portable
authorization for a later transaction.

Additive migration 71 introduces private function siblings and a dispatcher.
Published migrations 1–70, the original historical/current readers and all
financial writers remain unchanged. The original readers continue rejecting an
additional target draft. Only the new inventory path allows exactly one selected
target after independently authenticating its real immutable command, binding,
request/command hashes, public intent/order scope, current metadata, allocated
client identity, initial CREATE event and untouched progress. It requires
`CREATED`, version zero, no dispatch, fills, reservation or other native history.
Another unselected draft or unsupported history rejects the entire capture.

The source retains the accepted GLOBAL → tenant/user → sorted account/book/order
lock boundary and market-key/catalog locks. It captures current policies, rules,
capabilities, runtime health, controls, market/FX/liquidity, complete supported
inventory and durable UTC loss evidence. All existing native-time ticker conflict,
freshness, conservative collateral, bounded catch-up and finite-lease guards stay
in force. A new intent uses current rules; the original execution retains its
historical rules. Missing, stale, conflicting or incomplete evidence fails closed.

## Counting and result

The certificate keeps the actual count of all tenant PAPER intents in its captured
minute bucket, including the new durable target. The internal stored-target
calculator removes exactly this authenticated intent from the policy proposal's
starting count when its durable `createdAt` belongs to that bucket; the common
policy then adds the proposal once. It uses certificate creation time, not a
later read clock. A target newer than its certificate or an impossible zero count
is rejected. An older target outside the captured bucket receives no subtraction.
The public pure calculator for an unpersisted proposal retains its original
semantics; no caller-supplied counter adjustment is exposed by either entrypoint.

The immutable result binds the real target command and scope, finite current
certificate and calculation. `EVALUATED` means arithmetic/policy evaluation only.
Existing position, residual order exposure, reservations and holds are counted
once; fee coverage remains separate. A future atomic writer must independently
repeat current capture/evaluation and reserve in its own bounded transaction.

`capture` may persist only the existing nonfinancial loss checkpoints/certificate.
Exact valid source replay preserves certificate identity, revision and clocks.
`readCurrent` cannot create/renew it. `advanceLoss` exposes bounded durable
progress without a grant. Uncertain COMMIT returns no result; explicit restart
read reconciles the durable nonfinancial outcome. Abort/deadline/physical cleanup
remain bounded; no slot is freed before transport settlement and no blind retry
is introduced.

## Acceptance boundary

Tests cover genuine durable target authentication, count-once semantics, current
rule replacement and retirement, original-reader rejection, conflicting selectors,
extra drafts, pause/permission gates, concurrent capture and lost-COMMIT restart
without additional financial effects. Migration acceptance must include populated
70→71 upgrade/redeploy, unchanged old rows/functions, restricted owners, compiled
restart, reset and full Ubuntu/Windows/native/Docker/CodeQL CI. Local diagnostics
are not substitutes for independent CI.

LIVE and financial PAPER dispatch, positive native collateral credit and PHASE 14
remain disabled. Native AMEND remains Binance Spot TESTNET only. Real private
exchange acceptance, crash/backup restore and production soak are not claimed.
