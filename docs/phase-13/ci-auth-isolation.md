# Isolated Auth acceptance in PHASE 13 CI

## Accepted isolated Auth CI source checkpoint

Starting protected main **fe5bc77d76e39aeddcf165811c4e3e70319b2c3a**. Corrected source **e4f3a746270d5cff07b3283546b05b510d7eb1c6** passed [source CI 39132678725](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39132678725), [source CodeQL 39132678729](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39132678729), [PR CI 39132682288](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39132682288) and [PR CodeQL 39132682289](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39132682289). Exact-SHA artifacts, successful-job windows and ZIP SHA256 digests were verified. Both OS suites passed **4294 unit (1097 Paper) / 41 HTTP**; native PostgreSQL passed the same **1257 assertions in 38 files**, including all earlier identities, owner and upgrade proofs. Twelve clean deployments and audits pass; no open CodeQL alerts. All thirteen local baseline/regression commands and 62 targeted contracts pass. Sandbox EPERM was a launcher failure, not product RED.

Two initial RED contracts prove the separate Auth job and mandatory aggregate result. The first split passed 61 targeted contracts and its local 13-command regression with 4293 unit tests; those results did not cover the later reset finding. A third RED contract found that initial split candidate `fec57bb` omitted the populated post-Auth reset; that candidate is superseded and is **not acceptance**. The original reset proof is now shared: isolated Auth first proves at least 100 actual users, then resets and reapplies all 50 migrations with the original empty-state/PAUSED assertions. Verified source/PR pre-reset user counts are 108/108. Original Auth commands and all database assertions remain; the extraction comparison and frozen migration blobs are retained.

CI now has six Platform jobs and five artifacts: OS matrix, isolated native PostgreSQL, isolated **Auth runtime and faults**, Docker smoke and the same branch-required **Real services and Docker smoke** aggregate. The aggregate accepts only native/Auth/smoke success; failed, skipped, cancelled or missing evidence fails. Auth has its own owned PostgreSQL/Redis/SMTP environment, a 360-second parent and unchanged 120/180-second children; native remains 480 seconds, database/full parent 1020 seconds, native job 20 minutes, Auth/smoke 10 minutes and gate 1 minute. Native reports mark Auth **DELEGATED**, never PASS; acceptance also requires the actual Auth artifact and populated reset. Default/legacy commands retain full inline coverage. Source native/Auth parent elapsed times: 751798/92838 ms. These runs do not establish shared-host timing reliability or an Auth runtime fix.

All **50 published migrations**, native financial runtime, accepted PAPER source, adapters, dependencies, CodeQL and strict branch-required contexts remain unchanged. Final documentation-head CI, ordinary protected merge of [PR #29](https://github.com/dendenden-boop/tradeGPTbot/pull/29) and exact-main CI remain separate requirements; final IDs and protection proof are recorded in the PR/checkpoint after verification. Historical checkpoints below retain their original scope and results.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** General active/UNKNOWN history, capabilities/certification, vector reservations/Portfolio holds, final validation, authenticated operational sensors/bootstrap/supervisor and virtual execution remain outstanding. LIVE/PAPER financial dispatch and positive native credit stay disabled; native AMEND remains Binance Spot TESTNET only. No local native PostgreSQL/Docker, real private exchange acceptance or production soak is claimed.

## Scope and reproduction

Starting protected main: **fe5bc77d76e39aeddcf165811c4e3e70319b2c3a**, accepted through [PR #28](https://github.com/dendenden-boop/tradeGPTbot/pull/28) and [main CI 39127538949](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39127538949). All 50 published migrations, financial runtime, adapters, dependencies and accepted PAPER source implementations remain unchanged.

The previous serial database parent had a 1020-second limit. Source run [39016868170 attempt 1](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39016868170/attempts/1) and review PR run [39124276205 attempt 1](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39124276205/attempts/1) exhausted it after all 1257 native assertions and 78 authority/context-owner cases passed. Compiled Auth passed, but Auth load reported expected 202 / received 503 during enumeration as the parent expired. The failed PR native suite took 467565 ms, compared with 316764 ms in its successful independent source run. These failed attempts remain **NOT acceptance**. They do not establish an Auth runtime defect or a runtime fix.

Two new RED contracts require a separately budgeted Auth job and its explicit result in the existing aggregate gate. Both failed before implementation. The corrected 62 targeted contracts pass, including the existing deadline identity, proof selection, partial reports and actual gate process. At that candidate checkpoint, full new-head native/CI acceptance was still pending; the accepted source evidence is recorded above.

A further review contract reproduced a coverage gap in split candidate `fec57bb`: isolated Auth created real data but did not run the original post-Auth reset. That candidate is superseded and is not acceptance. The third RED contract failed before correction. The shared original reset proof now runs after Auth, after verifying at least 100 real users exist; the isolated report records that count and successful reset. The native/default reset assertions remain unchanged.

## Execution contract

The integration runner accepts only these explicit scopes; conflicting, unknown or extra arguments reject before Docker/SQL setup.

| Invocation                                | Required execution                                                                                    | Parent limit |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| `pnpm test:integration` or `--proof=full` | Existing service probes, full owner/upgrade/native/reset proof, compiled Auth and Auth load inline    | 1020 seconds |
| `pnpm test:integration --database-only`   | Legacy behavior: omit service probes, retain the full database and inline Auth proof                  | 1020 seconds |
| `pnpm test:integration --proof=database`  | Service probes and every owner/upgrade/native/reset assertion; explicitly delegate compiled Auth/load | 1020 seconds |
| `pnpm test:integration --proof=auth`      | Fresh owned database, all migrations applied twice, existing compiled Auth and Auth load scripts      | 360 seconds  |

Auth keeps its existing 120/180-second child deadlines; its separate parent includes 60 seconds for owned setup and reset. The native suite remains 480 seconds, each native test 15 seconds and each hook 30 seconds. Default/legacy serial execution is preserved and can still exhaust its bounded parent on a slow host; the CI correction gives Auth its own environment and budget.

The existing setup and Auth commands are extracted, not replaced. The database assertions and original Auth invocation blocks are compared against the starting source. No owner/upgrade/native/reset assertion, public API authorization check, SMTP flow, queue/load refusal, Redis fault or recovery assertion is removed. The additional Auth proof validates a fresh database with all 50 migrations and successful reports from this invocation, followed by the original reset proof.

## Isolation and reports

Native, Auth and smoke jobs own separate runner environments and independent Compose projects, credentials, PostgreSQL/Redis endpoints and cleanup. Auth is not run concurrently with role-graph tests in the same cluster: those tests intentionally change cluster-wide grants. Existing exact-project/loopback/credential guards run before creating database objects. The original cleanup remains mandatory after partial failure.

Reports declare `proofScope`:

- `database.json` in database scope marks `authenticatedRuntime` and `authenticationHardening` as `DELEGATED`, with required job `Auth runtime and faults`. It never claims those checks passed there.
- `database-auth.json` contains only the isolated Auth proof. It requires successful compiled/runtime and load reports and the populated post-Auth reset, and does not claim the 1257 native cases.
- Default full scope retains both original Auth `PASS` fields and the full database report.
- The parent validates the expected report scope, status and delegation fields. Missing, conflicting or incomplete reports reject.

Artifacts remain separate: OS reports, `bootstrap-docker`, `bootstrap-auth` and `bootstrap-smoke`. Complete acceptance combines the native proof with actual Auth reports from the independent Auth artifact. A delegated field alone is insufficient.

## Required gate and acceptance

The existing branch-required context **Real services and Docker smoke** always runs after `[native, auth, smoke]`. Only three literal successful results pass. Missing, failed, cancelled, skipped or unexpected evidence fails, including when either other job passed. CLI process tests cover missing/failed Auth. No branch protection context, scanner, query pack or source path exclusion is changed.

CI job caps remain 20 minutes native, 10 minutes smoke and 1 minute gate; isolated Auth has a 10-minute cap. OS matrix caps remain 15 minutes. Full source/PR/review/protected-main CI, CodeQL, every old native/owner identity, twelve clean deployments and audits remain required. Local unit proof is not native PostgreSQL/Docker acceptance, shared-host timing reliability or production soak.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** No new Paper financial behavior is implemented. LIVE/PAPER financial dispatch and positive native credit remain disabled; native AMEND remains Binance Spot TESTNET only. General active/UNKNOWN history, certification, reservations/holds, final validation, operational sensors and virtual execution remain outstanding. Real private exchange acceptance is not claimed.
