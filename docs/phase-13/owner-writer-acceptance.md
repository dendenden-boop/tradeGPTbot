# Restricted-owner writer acceptance

This is test orchestration for PHASE13, not Paper dispatch or a Risk grant.
Code checkpoint `8189fc2` passes all13 local commands and independent source/PR
CI as recorded in [verification](verification.md). Any later docs-only head
requires fresh complete CI; an authorized merge requires its own main CI. At
this review snapshot main `e356367` remains HOLD; PHASE13 stays IN_PROGRESS /
NOT READY FOR PHASE14.

The primary native cohort still executes the complete original49-case file in
one sequential process under its existing480-second aggregate budget. All test
bodies, financial runtime, published migrations1–71, workflow permissions and
required checks remain unchanged.

The additional restricted-owner proof executes two complementary selections of
that same file:20 execution/book cases and29 valuation/inventory/Risk cases. Two
real PostgreSQL databases isolate their state. The second is cloned from the
idle, normally closed owner database; no backend is forcibly disconnected. Both
databases must prove all71 matching migration checksums, the same restricted
owner and database ACL, distinct database OIDs, and the existing non-bypass
storage/function checks. No privilege is added to a runtime login.

The migration-only owner's existing profile is LOGIN/INHERIT/CREATEROLE with
NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOREPLICATION. Runtime logins retain their
NOCREATEROLE profile. Preflight and the aggregate gate validate actual server
flags, not an assumption that migration and runtime roles share privileges.
The original stricter NOCREATEROLE clone check reproduced RED in both CI runs
on `4ad1c8b`; its correction changes no role or grant.

One90-second budget starts before the new clone/storage preflight. Both child
startups and physical closure consume that same monotonic budget; neither child
receives a new allowance. At most two top-level test processes run. Failure or
abort kills and drains both owned process trees, including descendants. The
original1020-second shared native window still applies to the whole acceptance.

On POSIX, direct child close can precede the worker process group disappearing.
Success also requires ESRCH from the owned group probe. Orchestration drains
that group within the same original remaining budget; a persistent group,
abort, or an unexpected kernel error fails closed. The source proof on `ae2c5f4`
passes the complete owner proof in49.877s, while its PR run reproduces immediate
group rejection. The subsequent `8189fc2` source/PR proofs both pass, including
physical group drainage, under the same original90s budget.

The21 executable test-side fixture/configuration inputs have an exact
LF-normalized fingerprint. Unknown input changes require renewed isolation
review. The49-case manifest must match the actual native source. Existing
predecessor hashes and tamper checks remain; the original owner invocation and
all assertions can be reconstructed exactly below the reviewed orchestration.

Both raw Vitest reports are retained. Each contains its selected actual passing
cases and the complementary unselected cases. The gate checks that every one of
the original49 identities passes in exactly one partition; overlap, missing,
failed or skipped selected cases fail closed. A clearly labelled derived owner
view contains the actual passing assertion records, both raw byte hashes,
physical execution times, ownership evidence and the run-bound window identity.
The derived view is never substituted for the raw files: the real-services gate
requires and revalidates both files and the current input fingerprint.

Earlier local evidence includes RED→GREEN raw-evidence and physical-process
contracts, the original820 scripts tests passing before the final input guards,
and an actual Prisma71 deploy followed by clone/storage/owner/ACL verification on
native PostgreSQL. The owned cluster is physically stopped. This storage-only
diagnostic does not claim the complete restricted-owner49-case CI result. The
earlier Windows clock/freshness failures remain recorded without weakening clock
guards or deadlines. These diagnostics do not substitute for full CI acceptance.

An earlier targeted Vitest checkpoint passes80 tests across seven files, including
the real process/descendant lifecycle, raw-evidence gate and predecessor guards.
This does not replace the full regression or independent CI.

The verified `8189fc2` checkpoint passes6,675 unit tests, including842 script
contracts,2,610 Paper tests,41 HTTP tests, twelve clean deployments and audit0.
Source Platform43888665810/CodeQL43888666009 and PR Platform43888683001/
CodeQL43888683167 are GREEN. Each proves1,528 PostgreSQL cases,24 owners and all49
writer cases; the full owner budget is61.433/56.698s under90s. All12 ZIP sets,
four native raw logs and94 report copies verify, including both pairs of raw
20/29 partitions. The source primary aggregate is473.847s under480s, leaving
6.153s; an independent own-main run remains mandatory. Published migrations1–71,
runtime, permissions, checks and budgets are unchanged.

Financial PAPER/LIVE dispatch and positive native collateral credit remain
disabled. Atomic postexecution evaluate-and-reserve and PHASE14 have not started.
