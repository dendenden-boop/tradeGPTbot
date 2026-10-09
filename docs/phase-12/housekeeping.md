# PHASE 12 housekeeping and protected main

## Scope and baseline

Fresh clean main: **754c969dcbe9882417f8ff893b4c2fb96b1c5c3e**, fetched and reconfirmed on 9 October 2026. Accepted documentation main **754c969dcbe9882417f8ff893b4c2fb96b1c5c3e** passed [CI 37929257903](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37929257903) and [CodeQL 37929257839](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/37929257839); the runtime is identical to accepted main 296972e7a428bfcb60227c84434ab51debd519aa. Artifacts verified 2026-10-09T12:34:14.448Z: 3033 unit / 41 HTTP per OS, 666 native PostgreSQL plus populated upgrade, owner repeats 14/95, eleven clean deployments per OS, dependency audit zero and no open CodeQL findings. Docker authenticated smoke made 46 requests; shutdown was 285ms. PHASE 12 acceptance is preserved: **READY FOR PHASE 13**. LIVE remains disabled; PHASE 13 has not started. Native AMEND is supported only by Binance Spot TESTNET standalone LIMIT/GTC cumulative quantity decrease at unchanged price, with preserved native order ID and a new server client ID. Other profiles remain UNSUPPORTED. Conservative principal/fee/UNKNOWN holds remain; positive native credit is disabled. Real private exchange tests and production soak are not claimed. Housekeeping changes only documentation and GitHub configuration; published migrations 1–34, runtime packages, financial authority, pinned workflows and frozen lock are unchanged. Paper Engine is outside this task.

README, Risk design, roadmap and PHASE 12 documents now distinguish accepted composition from historical increment scope. Existing RED→GREEN, failed/green CI evidence and unsupported/private-exchange/soak limits are preserved; a past NOT READY is not a current gate.

## Actual main protection

GitHub administrative access was confirmed. Before housekeeping the REST protection endpoint returned 404 and main.protected was false; the ruleset list was empty. Classic branch protection was then installed and reread through the GitHub API at **2026-10-09 16:12 MSK (2026-10-09T13:12:11.588Z)**. Both main.protected=true and the complete protection configuration were verified.

| Setting                         | Confirmed configuration                                      |
| ------------------------------- | ------------------------------------------------------------ |
| Pull request                    | Required before merge; no direct push bypass allowance       |
| Required reviews                | 0; independent approval was not requested and is not claimed |
| Status checks                   | Required, strict=true (PR branch must be up to date)         |
| Check source                    | Every context pinned to GitHub Actions app_id=15368          |
| Administrator enforcement       | enforce_admins.enabled=true                                  |
| PR bypass users/teams/apps      | Empty                                                        |
| Force push / deletion           | Both disabled, including administrator enforcement           |
| Branch locking / linear history | Not enabled; ordinary checked PR merges remain possible      |

Actual required contexts, read from successful check-runs rather than guessed workflow names:

- Checks (ubuntu-24.04)
- Checks (windows-2025)
- Real services and Docker smoke
- CodeQL JavaScript and TypeScript

Both pinned workflows trigger on push and pull_request with no path filter. The real-services job follows both OS checks; any required failed/pending/missing check blocks merge. No missing workflow or extra unattainable context was required. Required checks are satisfied only by the configured GitHub Actions app. Documentation uses the full existing CI, including PostgreSQL and Docker; no check is weakened.

The [GitHub branch protection API](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection) defines strict and administrator enforcement. Protection prevents bypass in the merge/push operation; repository administrators/owners retain their GitHub right to edit protection settings. Configuration immutability against the owner is not claimed. GitHub considers successful/neutral/skipped checks acceptable; these unfiltered workflows are verified to have actually executed all required jobs successfully. No queue, required deployment, separate review or signed-commit rule is claimed.

## Verification and handoff

Baseline and changed documents are checked with pnpm format:check, docs:check, lint and typecheck. The change is published on codex/phase12-housekeeping through a PR; the full platform CI and CodeQL must succeed before its ordinary merge, with protection left enabled. Fresh final-main CI and API reread are required for final handoff. The final external report identifies PR, source/final SHA and exact run IDs after their completion; this document does not claim future CI results.

Read-only verification endpoints:

- GET /repos/dendenden-boop/tradeGPTbot/branches/main
- GET /repos/dendenden-boop/tradeGPTbot/branches/main/protection
- GET /repos/dendenden-boop/tradeGPTbot/commits/{sha}/check-runs

Sanitized local evidence is retained in test-results/phase12-housekeeping: protection request/response/reread, exact check contexts, baseline/post-change logs and final CI artifact verification. No runtime or financial tests are added for a documentation-only change; the complete existing regression suite remains required. Housekeeping is complete only after green exact-head CI and confirmed protection; PHASE 13 is not started.
