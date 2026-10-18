# Isolated Auth acceptance in PHASE 13 CI

## Scope and reproduction

Starting protected main: **fe5bc77d76e39aeddcf165811c4e3e70319b2c3a**, accepted through [PR #28](https://github.com/dendenden-boop/tradeGPTbot/pull/28) and [main CI 39127538949](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39127538949). All 50 published migrations, financial runtime, adapters, dependencies and accepted PAPER source implementations remain unchanged.

The previous serial database parent had a 1020-second limit. Source run [39016868170 attempt 1](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39016868170/attempts/1) and review PR run [39124276205 attempt 1](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39124276205/attempts/1) exhausted it after all 1257 native assertions and 78 authority/context-owner cases passed. Compiled Auth passed, but Auth load reported expected 202 / received 503 during enumeration as the parent expired. The failed PR native suite took 467565 ms, compared with 316764 ms in its successful independent source run. These failed attempts remain **NOT acceptance**. They do not establish an Auth runtime defect or a runtime fix.

Two new RED contracts require a separately budgeted Auth job and its explicit result in the existing aggregate gate. Both failed before implementation. The corrected 61 targeted contracts pass, including the existing deadline identity, proof selection, partial reports and actual gate process. Full new-head native/CI acceptance is pending until executed and recorded.

## Execution contract

The integration runner accepts only these explicit scopes; conflicting, unknown or extra arguments reject before Docker/SQL setup.

| Invocation                                | Required execution                                                                                    | Parent limit |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| `pnpm test:integration` or `--proof=full` | Existing service probes, full owner/upgrade/native/reset proof, compiled Auth and Auth load inline    | 1020 seconds |
| `pnpm test:integration --database-only`   | Legacy behavior: omit service probes, retain the full database and inline Auth proof                  | 1020 seconds |
| `pnpm test:integration --proof=database`  | Service probes and every owner/upgrade/native/reset assertion; explicitly delegate compiled Auth/load | 1020 seconds |
| `pnpm test:integration --proof=auth`      | Fresh owned database, all migrations applied twice, existing compiled Auth and Auth load scripts      | 360 seconds  |

Auth keeps its existing 120/180-second child deadlines; its separate parent includes 60 seconds for owned setup. The native suite remains 480 seconds, each native test 15 seconds and each hook 30 seconds. Default/legacy serial execution is preserved and can still exhaust its bounded parent on a slow host; the CI correction gives Auth its own environment and budget.

The existing setup and Auth commands are extracted, not replaced. The database assertions and original Auth invocation blocks are compared against the starting source. No owner/upgrade/native/reset assertion, public API authorization check, SMTP flow, queue/load refusal, Redis fault or recovery assertion is removed. The additional Auth proof validates a fresh database with all 50 migrations and successful reports from this invocation.

## Isolation and reports

Native, Auth and smoke jobs own separate runner environments and independent Compose projects, credentials, PostgreSQL/Redis endpoints and cleanup. Auth is not run concurrently with role-graph tests in the same cluster: those tests intentionally change cluster-wide grants. Existing exact-project/loopback/credential guards run before creating database objects. The original cleanup remains mandatory after partial failure.

Reports declare `proofScope`:

- `database.json` in database scope marks `authenticatedRuntime` and `authenticationHardening` as `DELEGATED`, with required job `Auth runtime and faults`. It never claims those checks passed there.
- `database-auth.json` contains only the isolated Auth proof. It requires successful compiled/runtime and load reports and does not claim the 1257 native cases.
- Default full scope retains both original Auth `PASS` fields and the full database report.
- The parent validates the expected report scope, status and delegation fields. Missing, conflicting or incomplete reports reject.

Artifacts remain separate: OS reports, `bootstrap-docker`, `bootstrap-auth` and `bootstrap-smoke`. Complete acceptance combines the native proof with actual Auth reports from the independent Auth artifact. A delegated field alone is insufficient.

## Required gate and acceptance

The existing branch-required context **Real services and Docker smoke** always runs after `[native, auth, smoke]`. Only three literal successful results pass. Missing, failed, cancelled, skipped or unexpected evidence fails, including when either other job passed. CLI process tests cover missing/failed Auth. No branch protection context, scanner, query pack or source path exclusion is changed.

CI job caps remain 20 minutes native, 10 minutes smoke and 1 minute gate; isolated Auth has a 10-minute cap. OS matrix caps remain 15 minutes. Full source/PR/review/protected-main CI, CodeQL, every old native/owner identity, twelve clean deployments and audits remain required. Local unit proof is not native PostgreSQL/Docker acceptance, shared-host timing reliability or production soak.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** No new Paper financial behavior is implemented. LIVE/PAPER financial dispatch and positive native credit remain disabled; native AMEND remains Binance Spot TESTNET only. General active/UNKNOWN history, certification, reservations/holds, final validation, operational sensors and virtual execution remain outstanding. Real private exchange acceptance is not claimed.
