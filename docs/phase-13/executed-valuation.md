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

## Implementation checkpoint

The new server-only source uses a fixed reconciliation kind and additive
`202611120001_paper_executed_valuation`. It authenticates through published66
causal reconciliation under GLOBAL → tenant → account/book locks, then holds
stable instrument/rule/public-head catalogs. Original configuration defines
valuation asset and public source scope. The traded base pins its original
database and logical instrument identities; other funded currencies require
unambiguous direct public prices. At most 64 heads and 16 MiB are admitted.
No role, table, financial writer, generic Risk/Portfolio contract or dispatch
capability is added. Only current readonly reconciliation is wrapped; all old
kinds delegate to the exact retained function.

Targeted unit implementation passes the original 24 valuation contracts and
all 31 accepted executed-book contracts. A real PostgreSQL diagnostic passes
the first six valuation cases. The additional v1→v2 case exposed a fixture
attempting to read a retired head with the new key; the fixture now obtains
the actual revision before retiring v1 and publishes legitimate v2 metadata.
The runtime freshness/order guards remain intact.

A separate fresh diagnostic first commits a genuine execution on published66,
then applies67. All populated rows and prior function definitions/OIDs/owners
are retained except the explicitly renamed private reconciliation wrapper and
its narrowed ACL. The compiled production source reads the same book, survives
factory restart, preserves finite price expiry and changes no row. Selected
financial-kernel owners are non-BYPASSRLS; this remains a Windows startup-GUC
diagnostic, not proof of the complete Linux CI topology, redeploy or reset.

The CI harness extends the same existing owner suite to 27 cases. Its new
reconstruction layer proves exact accepted Daa bytes beneath reviewed migration,
count and proof additions; preceding assertions and original deadlines remain.
The corrected fresh PostgreSQL diagnostic passes all 27 writer/book/valuation
cases unfiltered, including legitimate current v2 metadata and all original20
cases. Its 103.89-second Windows wall time is not acceptance of the unchanged
90-second Linux owner gate. The server stops with `postmaster.pid` absent.
Thirty-two valuation units and twelve new exact-predecessor harness contracts
also pass targeted verification. GitHub API still reports Daa as protected main:
strict five app-bound contexts, enforced admins, mandatory PR, force push and
deletion disabled. No settings are changed.

Full frozen regression, original owners, populated upgrade/redeploy/reset,
independent CI and artifact/protection checks remain required. No new CI
success, soak or final gate is claimed.
