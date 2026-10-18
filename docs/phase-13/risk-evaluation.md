# PAPER Risk evaluation calculation

Starting main: `8dd14f4b77c3bda8a5f0df3003be54adde55bd07`. Its isolated CI increment was accepted through protected PR #29 and exact-main Platform run 39149926485 / CodeQL 39149926492. All thirteen local baseline commands passed before these changes.

## Contract and authority boundary

`calculatePaperRiskEvaluation({now, request, capture})`, exported from the pure `@ctp/paper-engine` root, composes the accepted tenant cash context with the existing conservative vector budget, UTC loss reconstruction and common `evaluateRiskPolicy`. It performs no I/O. Its immutable `PAPER_RISK_EVALUATION_CALCULATION` result contains either rejection reasons or an evaluated notional and the complete asset debit vector, including available/remaining amounts. It never implements `OrderRiskPort.approve`, certifies a snapshot, persists a decision/reservation/hold, grants a permit or dispatches an order. Serialized capture, hash, model capability and JSON replay establish no SQL source authority.

The future certified coordinator must independently capture current evidence under the shared locks, re-evaluate and atomically persist the entire reservation vector, then revalidate immediately before consuming a one-use permit. This calculation does not close that acceptance requirement. The accepted SQL financial admission still rejects PAPER, and Order Engine still refuses PAPER financial dispatch.

## Supported evidence

This increment supports only the existing complete, bounded pristine quote-cash inventory and SPOT BUY LIMIT/MARKET commands. The accepted decoder must bind the exact immutable target/draft, account/book, permission/session epochs, current policies/controls, original model/publications/runtime facts and all tenant cash books. Active/UNKNOWN orders, holds, noncash inventory, omitted/conflicting books and general economic history remain unsupported. Empty positions/orders/reservations/holds are justified only by this pristine source contract, never by caller defaults. FX is identity only when the instrument quote is the proven valuation asset; no native collateral credit, cash pooling, leverage or guessed FX is introduced.

The calculator recomputes both model envelope and full debit budget rather than accepting a caller proposal, envelope, capability or exposure. Current limits apply to instrument/asset/account/user budgets and positions/open orders; recent tenant draft frequency excludes the target intent exactly once. Historical snapshot/funding timestamps remain unchanged. Freshness uses the original witnesses and exclusive minimum deadline, including UTC midnight. Today external funding does not manufacture a positive adjusted opening equity; the common policy rejects an unproved/zero loss baseline.

Liquidity is a conservative top-of-book/observed-trade lower bound: floor `min(bestBidQty, bestAskQty, tradeQty) × participationRate` to the original lot, then multiply by the lower best price. All arithmetic uses decimal strings and a private Decimal constructor, without Number conversion or lot-count iteration. The common policy also checks original reference price, spread, execution bounds, fee rate, pauses, circuits and all nine observed health dependencies. Its legacy `exchangeRest/privateStream` slots carry PAPER `publicMarket/executor` facts, respectively; no native private connection is invented. PAPER has no private connection pause; actual global/user/strategy controls remain effective.

The lifetime envelope can conservatively reject MARKET or passive LIMIT requests whose price bounds cannot satisfy the common market/deviation checks. An evaluated mathematical execution bound is not worker enforcement or a dispatch permission. SELL, conditional commands and general positions need separate proved contracts before admission.

The common scalar fee proposal is discarded. Only the recomputed per-asset vector includes the worst-case per-lot commission ceiling. The remaining-balance floor is checked again against that complete vector. Tests distinguish this from a smaller scalar fee when the lot is `1e-18`.

## Model capability namespace

Pure common Risk evaluation accepts synthetic capabilities only for PAPER with market SPOT, accountMode `SIMULATED`, endpoint `paper-spot-v1`, profile version `spot-l2-taker-v1`, adapter version `paper-spot-l2-taker-v1`, and no credential reference. Model LIMIT/MARKET records are derived from the sealed configuration, exact instrument and original capture deadline. Their evidence link identifies the already accepted calculator implementation at starting main. SUPPORTED means those model calculations are supported; it makes no statement about native exchange transport.

Native implementations relabelled PAPER and native exchange profiles relabelled PAPER fail closed. TESTNET/DEMO/LIVE continue to reject synthetic capabilities; native profiles and financial admission behavior are unchanged. No AMEND/CANCEL/conditional capabilities are advertised by this calculation.

## Verification and remaining gate

Before implementation, the missing root calculation failed its export contract. The final model-profile contracts were also replayed against the unchanged starting-main policy: 12 failed / 6 passed / zero skipped. They cover rejected simulator support and accepted counterfeit native/model profiles, plus precise namespace rejection. Earlier fixture/launcher failures are retained separately and are not product RED evidence. Targeted GREEN, full regression and native/CI results belong in [verification](verification.md), after actual execution.

Native PostgreSQL cases exercise the actual restricted tenant capture with healthy/today-funded, UNKNOWN/restarted and refreshed policy/control evidence, proving rejection without another monetary effect. Explicit test observations are fixtures, not operational health certification. All 50 published migrations, native financial source/adapters, dependency pins, workflows and check deadlines stay frozen; the runner's strict authority-owner count increases only for the three additional cases.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** Certification, general active/UNKNOWN history, vector reservations/Portfolio holds, final dispatch validation, authenticated operational sensors/bootstrap/supervisor and virtual execution remain outstanding. LIVE/PAPER financial dispatch and positive native credit stay disabled; native AMEND remains Binance Spot TESTNET only. No local native PostgreSQL/Docker, real private exchange acceptance or production soak is claimed.
