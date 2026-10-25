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

## Gate

Dependency changes, GREEN regression and complete new-head/source/PR/protected-main
CI remain required at this tests-first checkpoint. Previous failures are not
overwritten. Published migrations 1–56, financial source, adapter logic, audit
threshold, workflows, release-age policy and deadlines must remain unchanged.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14.** LIVE/PAPER financial dispatch
and positive native collateral credit remain disabled. Native AMEND remains
Binance Spot TESTNET only. Pure unsent cancellation preparation is not durable
public CANCEL. Real private exchange acceptance, crash/backup restore and
production soak are not claimed.
