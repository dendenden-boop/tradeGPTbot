# Current PAPER Risk evaluation after execution

## Starting point

The starting protected main is `9f2f324cfdaf0276e9ad5c0981d7d14b6d52199c`
(PR74). Its own [Platform43705701033](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43705701033)
and [CodeQL43705701125](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/43705701125)
passed: 6,501 unit / 41 HTTP per OS, 1,520 PostgreSQL, 24 owner suites,
41 execution writer/capture cases, 70 migrations and audits0. The earlier
525aaac main failure remains historical; it does not describe accepted9f2f324.

A fresh unchanged9f2f324 baseline passed all13 local commands on15November2026:
format/docs/lint/typecheck/unit/HTTP/db:validate/build/runtime/clean and all three
audits. All1,077 tracked input hashes remained unchanged. This baseline is not
acceptance of a later source.

## Contract and limits

`calculatePaperCurrentRiskEvaluation` is a pure calculation exported from the
package root. Its input is bounded JSON: current certificate **content**, its
original strict execution selector, a server-scope target description and time.
It reuses the accepted current-certificate decoder, complete supported historical
inventory, budget/fee-vector arithmetic and common Risk policy. Neither supplied
JSON nor valid hashes prove storage provenance, current heads or durable target
identity. A future fixed atomic admission writer must acquire fresh coherent
evidence, authenticate the new immutable intent and independently repeat checks
before any reservation or execution.

Only a new Spot BUY LIMIT/MARKET calculation in the same exact PAPER account,
profile and current instrument/rules is supported. The original execution's
order/intent cannot be reused as a new target. The accepted inventory closure
remains one executed order and pristine sibling books; no general history,
UNKNOWN resolution, SELL base availability or cross-currency FX is inferred.

Existing positions and each remaining order/reservation/hold are translated into
the existing budget calculator. A remaining order and its reservation are one
notional identity; fee collateral is a separate availability liability. All
positions, accounts and holds remain present. Independently derived instrument,
asset, account and user exposure, open-order/position counts and quote spendable
balance must match the certified snapshot before common policy evaluation.
The new order adds exposure once and pays its complete worst-case per-lot fee
vector. Sibling money cannot fund the target account. Current frequency, loss
baseline/high-watermark, controls, health, rules and capabilities remain binding.

The original certificate is immutable and retains
`market.executionBoundEnforced=false`. Only the local mathematical proposal uses
the recomputed price envelope for policy calculation. No code enforces a new
execution cap or authorizes transport here. A future writer must actually enforce
the bound. EVALUATED is neither a grant, permit, reservation, target authentication
nor permission to retry a financial operation. Evidence expiry is never renewed.

No financial writer, published migration, policy evaluator, adapter, workflow,
permission or time budget changes in this increment. Current atomic postexecution
admission and continued/multiple-order/SELL/conditional execution, shared liquidity
and public operational composition remain outstanding.

## Verification checkpoint — candidate, not accepted

Tests first: the absent export initially reproduced17 failing contracts and one
passing input rejection. The final36 contracts were also run with the exact9f2f324
predecessor root export:35 missing-export failures and one input rejection PASS;
the candidate index was restored byte-for-byte afterwards. Fixture corrections preserve strict JSON content and extract
the command from the full execution record, not its reference-only selector.
The latest targeted run passes110 tests:36 new current-evaluation contracts,
32 accepted certification contracts and42 accepted pristine-evaluation contracts.
It covers exact scopes, existing position exposure and counts, four limit levels,
per-lot fees, current drawdown/frequency/pause, stale rules, finite lease,
unsupported base availability, malformed/oversized/accessor/cyclic inputs and
absence of authority exports. Typecheck and changed-file lint have also passed
at intermediate checkpoints; full final-source regression is still required.

The real PostgreSQL test extends the existing actual certificate/restart case
with calculation over its immutable stored text/hash, checking position6.025 plus
new notional2.41 equals8.435 and unchanged financial/evidence rows. Its first local
fresh-cluster diagnostic failed with `PAPER_ADMISSION_EXPIRED` at the existing
`readCurrent`, before the new assertions. The failed report is retained and the
owned server was stopped. A separate timing diagnostic with the original first
execution case followed by the certificate case passed both cases, including all
new assertions and restart. Its final actual READ took345ms and returned before
the same original finite expiry; no SQL/result/clock/deadline was changed. The
Windows-only local startup-GUC normalization and5ms delivery latency are diagnostic
limitations, not production/native Linux acceptance. Both owned clusters were
stopped. Full regression and final-source source/PR CI remain open. No CI run for
this candidate is claimed here, and the first failure is not relabelled GREEN.

**PHASE13 IN_PROGRESS / NOT READY FOR PHASE14.** Financial PAPER/LIVE dispatch
and positive native collateral credit remain disabled. Collateral is conservative;
native AMEND remains Binance Spot TESTNET only. Real private exchange acceptance,
database crash/backup restore and production soak are not claimed.
