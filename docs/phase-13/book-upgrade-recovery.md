# Populated bootstrap upgrade recovery

## Starting state and observed failure

PR56 was merged, with explicit human permission, as protected main `47e3cc037855749b7da1b246959c402f74742432`. Its 892 tracked blobs equal the accepted source `2883812`. Source Platform40874341749, PR Platform40874352502 and their CodeQL runs passed. Main [Platform40877717348](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40877717348) failed; [CodeQL40877717261](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40877717261) passed. Both OS jobs, Auth, Docker and all 1,398 native PostgreSQL cases passed. All 67 admission owner cases passed, and 19 owner-suite reports were preserved. A subsequent populated upgrade from published40 to41 failed with `PAPER_BOOK_UNCERTAIN`, so the mandatory real-services gate correctly failed. All six failed-run ZIP digests were verified.

The sanitized historical log does not distinguish the original initialize, replay and read calls. It does not establish a particular host, transport or timing cause. Source/PR success does not waive this main failure, and the failed run is never relabeled as acceptance or rerun unchanged.

The production bootstrap port already fails closed after ambiguous COMMIT and provides an authoritative readonly recovery operation. Existing native coverage proves genuine lost-COMMIT recovery. This change addresses the upgrade fixture's assumption that every operation must deliver an acknowledgement; it does not change that runtime contract.

## Scope and contract

`packages/database/test/fixtures/book-upgrade-recovery.ts` is test-only. It is not exported by a production package, loaded by a worker or used as a generic runtime retry port. Accepted financial/adaptor runtime, dependency locks, workflows and every published migration1–61 remain unchanged. There is no new migration or financial feature.

Each of the three existing upgrade stages (`INITIALIZE`, `REPLAY`, `READ`) performs its original native operation exactly once, with the same owner and 2,500ms IO window. A normal result is verified before recording `ACKNOWLEDGED`. Only an actual native `Error('PAPER_BOOK_UNCERTAIN')` triggers one subsequent `read` with fresh bounded IO. That read must return a receipt verified against the original funding ID, configuration, funding receipt and lossless balances. Replay/read must additionally equal the complete original immutable receipt. A successful recovery records `RECOVERED_READ_ONLY`, never a fabricated acknowledgement.

The helper never repeats initialize after uncertainty. Missing, conflicting or still uncertain recovery leaves the fixture failed. Other native errors propagate without recovery; IO construction, validation and evidence-recorder errors cannot masquerade as native commit uncertainty. There is no retry loop, automatic adoption or result cache. The existing native reader creates a fresh transaction/socket for each read and retains its own abort, deadline, ownership and physical settlement guards.

The upgrade runner records the actual bounded transition trace in `paperBookUpgradeEvidence`, including the exact stage if a future operation fails. Completion requires the three stages in order, each with an acknowledged or verified readonly result, and no failed/unresolved event. Existing outer equality checks and all subsequent ledger, entry, book, evidence, outbox and provenance assertions still execute. No `UNKNOWN` or `DELEGATED` status is rewritten to `PASS`.

## Preservation and regression evidence

Fresh frozen baseline on unchanged47e passed all 13 format/docs/lint/typecheck/unit/HTTP/db/build/runtime/clean/audit commands: 5,640 unit, 41 HTTP, twelve clean deployments, audits0 and 892 unchanged tracked inputs. This is local baseline evidence; main native acceptance remains failed.

Tests-first commit `76d01f9` records 22 unit RED contracts and one selected native RED for the absent helper. After implementation, all 22 new contracts and three prior preservation guards pass. Tests cover acknowledged initialize/replay/read, uncertain outcomes, at most one readonly recapture, exact IO/owner forwarding, foreign receipt rejection, missing/still uncertain recovery, known failures and errors outside transport. Typecheck passes.

Two additional tests-first contracts in `186815b` reproduced early acknowledgement/recovery when a verifier returned a pending Promise (22 PASS/2 FAIL). The helper now awaits verification on both paths; all 24 new contracts plus three prior guards pass. The original 22-case RED/GREEN checkpoints remain historical.

The existing physical COMMIT-loss native case is extended without removing its original assertions. A fresh second account uses actual production configuration/funding/bootstrap ports and a real PostgreSQL proxy that suppresses an acknowledged server COMMIT. The helper performs exactly one initialize and one read, records genuine uncertainty and recovery, survives client reopen and retains one checkpoint with no second monetary effect. The selected diagnostic passes one case with 31 explicit filtered cases; this is not full native acceptance.

A second local diagnostic populates actual configuration/funding under the original first40 SQL migrations, applies unchanged published41, and executes the actual checked-in upgrade runner block against real ports. Dropping its first acknowledged initialize COMMIT yields the explicit readonly recovery trace, then real replay/read acknowledgements. All original financial assertions execute: one ledger transaction, two entries and one book/evidence/outbox record with unchanged funding provenance. This uses raw published SQL, not Prisma deploy/redeploy, and does not claim full restricted-owner coverage. The earlier ignored launcher failed syntax validation before exercising its fixture; the corrected parameterized launcher and its stopped cluster are recorded separately.

Strict test-only reconstruction retains the complete original published61 runner (LF-normalized SHA256 `9d2847162ea1c73b6c1326ccdc2a1373084c3ab00fe15ad494dd5f2f5db992e4`) and entire original32-case book suite (`e5a13d2bcf3e2c2aa8b2ab9f9c47eec7fe528f1025e79ab1f2261293533ecb7d`) outside the exact reviewed additions. Missing, duplicate and unexpected marker blocks reject. Earlier historical reconstruction guards remain enabled. Original 90s owner, 480s native and 1020s shared limits are unchanged; individual production IO limits are unchanged.

## Acceptance boundary

Candidate `ca9b357dfe1b88f56b5429c3f737d086aab7ec19` completed its frozen local run with all checks except lint passing: 5,664 unit, 41 HTTP, twelve clean deployments and audits0. Lint rejected the unqualified `setImmediate` global in the two new async-verification tests. Source Platform41016575705 and PR Platform41016587423 also failed lint; both CodeQL runs passed and dependent native jobs skipped. Both failed runs and their ZIP digests remain preserved; none was cancelled or rerun. The correction explicitly imports the Node timer in that unit file, without changing the helper, runtime, native assertions, dependencies or deadlines. The corrected HEAD requires its own complete regression and CI.

The candidate requires a new complete frozen regression and exact source/PR/protected-main CI: 5,664 unit, 1,398 PostgreSQL/42 files, 67 admission cases, all 19 owner suites/29 reports, real populated upgrades/deploy/redeploy/reset, Auth/Docker, CodeQL, audits and verified artifact digests/protection. The new evidence trace must be checked in both native producers. Actual run IDs/results belong to the PR and verified artifact checkpoint. Diagnostics alone do not accept the candidate or the failed published main.

**PHASE13 IN_PROGRESS / NOT READY FOR PHASE14.** Final atomic Risk/START/one-use permit and shared execution/allocation/ledger/Portfolio/hold composition remain outstanding. LIVE/PAPER financial dispatch and positive native credit stay disabled; native AMEND remains Binance Spot TESTNET only. Real private exchange acceptance, database crash/backup restore and production soak are not claimed.
