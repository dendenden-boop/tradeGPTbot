# PHASE 13 — executed-book valuation increment

Status: implementation in progress, not acceptance. Starting protected main:
`daa67eefef780915df8480690e573adebb3ebcd4` (accepted PR69).
PHASE 14 and financial PAPER/LIVE dispatch remain disabled.

The accepted pristine valuation source deliberately rejects evolved books. This
increment adds a separate server-only readonly source for the already accepted
single pristine Spot BUY execution. It must authenticate the actual committed
book and current ownership/permission epochs, then capture current public LAST
price heads coherently. It does not certify a complete tenant RiskSnapshot,
reserve money, admit another order, or extend execution scope.

Spot equity is the sum of current asset balances at current direct prices.
Unrealized PnL and net realized PnL are separate disclosures. Fees already applied
to balances must not be deducted again. Original execution, Portfolio snapshot,
economic-event and market timestamps remain unchanged. A fresh book capture
cannot renew cached price evidence. Missing, stale, ambiguous or conflicting
price/metadata/ownership evidence fails closed. No assumed stablecoin parity,
cost-basis fallback, caller prices or caller timestamps are accepted.

## RED checkpoint — 2026-11-12

- Unchanged starting-main baseline: all 13 commands passed; 6,228 unit, 41 HTTP,
  12 clean deployments, audit 0. Ignored evidence:
  `test-results/phase13-executed-valuation/baseline-verified.json`.
- Targeted unit contract: 23 failed / 1 passed because the server API is absent,
  not because the historical committed fixture is malformed.
- Real PostgreSQL 17 Windows diagnostic applied all 66 original migrations and
  committed an actual START execution through the accepted writer. The new
  valuation test then failed with `PAPER_EXECUTED_VALUATION_SOURCE_MISSING`.
  One selected case failed; 20 existing cases were deliberately filtered out,
  not claimed as regression acceptance. The owned cluster was stopped and its
  `postmaster.pid` absence verified. This diagnostic normalizes the unsupported
  Windows startup GUC, introduces no response delay, and is not full native Linux
  or CI owner-topology acceptance.
- RED reports: `test-results/phase13-executed-valuation/unit-red.json` and
  `native-red/local-native-tests.json` under the same ignored root.

No GREEN, migration, populated upgrade, CI, soak or final gate is claimed here.
