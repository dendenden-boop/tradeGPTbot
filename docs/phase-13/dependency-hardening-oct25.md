# Dependency audit recovery — 25 October 2026

## Observed failure and reproduction

PR [41](https://github.com/dendenden-boop/tradeGPTbot/pull/41) merged normally as
`c15b14b8c0bd343d6fd35d1b9361c2e2761355a5`, with a tree identical to its verified
final head. Its earlier source/PR evidence remains valid for those runs; it does
not establish acceptance of this main SHA. Main
[Platform 40193915441](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40193915441)
failed dependency audit on both operating systems. Native PostgreSQL, Auth and
Docker were consequently skipped, and the aggregate gate failed correctly.
[CodeQL 40193915704](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40193915704)
passed. No unchanged-source retry or CI waiver was requested.

A fresh audit of the unchanged lockfile reproduced **12 advisory records:
1 high, 7 moderate, 4 low**. They affect Zod, Nodemailer and both installed major
versions of fast-uri. These are dependency findings, not evidence that a
production exploit occurred.

Tests precede dependency changes. The new installed-dependency suite reproduces
**47 RED / 15 PASS in 62 cases**. It uses tiny collections and invocation counters,
synthetic `.invalid` addresses and in-process URI parsing, without network I/O,
memory exhaustion or timing thresholds. All eleven direct workspace Zod edges,
Auth and SMTP-fixture Nodemailer, and the real Fastify compiler/AJV fast-uri
dependencies are exercised. An initial sandbox temporary-file `EPERM` prevented
collection; that infrastructure failure is retained separately and is not counted
as RED. The same suite collected successfully with its temporary directory inside
the workspace.

## Upstream fixes and bounded regression scope

- [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) and
  [upstream patch](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd):
  4.6.6 rejects oversized bounded collections before element work. Tests cover
  array maximum/exact length, asynchronous elements, sets/maps and valid bounded
  transformations across every direct workspace importer. They do not claim to
  make unconstrained collections bounded.
- Nodemailer 10.1.4 fixes
  [nested comments](https://github.com/advisories/GHSA-8c8m-p3m8-cjg8),
  [group delimiters](https://github.com/advisories/GHSA-m943-m63m-w62w) and
  [quoted local delimiters](https://github.com/advisories/GHSA-85x2-q946-cp5h).
  Tests verify the actual parsed recipient domain and ordinary recipient lists on
  both installed edges. No email is sent.
- fast-uri 3.1.9 / 4.2.3 fix
  [encoded schemes](https://github.com/advisories/GHSA-w74x-v6f9-j3xg),
  [relative paths](https://github.com/advisories/GHSA-xhq7-xmqj-769h),
  [ambiguous hosts](https://github.com/advisories/GHSA-wjr9-j795-jxcr) and
  [suffix schemes](https://github.com/advisories/GHSA-333x-w4r6-6crp).
  Tests exercise each distinction and retain ordinary URI behavior for both
  installed majors.

## Implemented candidate and targeted evidence

Tests-first commit `08562c0b489be6600589a3c1f95c07762d802faa` precedes pin
changes. The candidate updates the eleven exact Zod pins to 4.6.6, Auth Nodemailer
to 10.1.4, its SMTP-fixture edge through one scoped override, and the existing
fast-uri overrides to 3.1.9 / 4.2.3. Only those four package/version records change
in the lockfile; no unrelated dependency or build policy is upgraded.

Frozen installation passed. A fresh raw audit of the candidate lockfile reports
**0 info / low / moderate / high / critical**. Targeted verification passes
**78/78**, comprising all 62 new cases and 16 existing dependency/policy cases.

The first candidate targeted run passed 76/78. Two suffix assertions incorrectly
expected malformed string normalization to discard a scheme; the implementation
preserves that raw invalid input. Upstream's fixed contract concerns serialization
of a suffix component whose original scheme is omitted. The assertions now test
that operation. Separate bounded diagnostics reproduce unsafe serialization on
the retained actual 3.1.8 / 4.1.5 packages and safe serialization on 3.1.9 / 4.2.3,
with file hashes and outputs retained. This correction is not a claimed additional
upstream defect, suppression or weakening of valid URI behavior.

## Historical candidate gate

Full regression and complete new-head/source/PR/protected-main CI remain required
at this candidate checkpoint. Previous failures are not
overwritten. Published migrations 1–56, financial source, adapter logic, audit
threshold, workflows, release-age policy and deadlines must remain unchanged.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** LIVE/PAPER financial dispatch
and positive native collateral credit remain disabled. Native AMEND remains
Binance Spot TESTNET only. Pure unsent cancellation preparation is not durable
public CANCEL. Real private exchange acceptance, crash/backup restore and
production soak are not claimed.

## Verified source and PR checkpoint

Corrected source `51dae36ba2493efa93109790ea4043e136dd67bb` passed full source [Platform 40195502641](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40195502641) / [CodeQL 40195502642](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40195502642) and PR [Platform 40195514859](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40195514859) / [CodeQL 40195514846](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/40195514846). Each OS passed 4,955 unit tests in 249 files, including all 4,893 previous identities and exactly 62 new dependency cases, 1,555 Paper / 41 HTTP and twelve clean deployments. All 1,370 native PostgreSQL identities in 42 files, 19 owner reports / 39 admission-owner cases and prior upgrade/reset/Auth/Docker checks remain. Artifact ZIP SHA-256 digests and producer windows, exact pins/lock graph, audit 0 at all severities, current CodeQL and strict main protection were verified.

All thirteen local commands passed with 818 tracked input hashes unchanged; raw zero-audit proof is bound to its actual producer window, lock digest and generated file. Native cohorts completed in 376697 / 378398 ms within the unchanged 480000 ms limit; database parents 825933 / 844716 ms within 1020000 ms. Existing owner deadlines are unchanged. These are run-specific results, not production throughput or soak evidence.

The prior failed main run remains failed. This source checkpoint does not claim exact-main acceptance. Final documentation-head and normal protected publication are recorded separately in [PR42](https://github.com/dendenden-boop/tradeGPTbot/pull/42). **PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**; LIVE/PAPER dispatch and positive credit remain disabled.
