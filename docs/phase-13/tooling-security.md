# PHASE 13 tooling security maintenance

## Reproduction — 21 October 2026

Starting protected main **6a4085b00d4e394b96376ee0868d9cd1b2697916** contains the initial atomic admission increment from [PR35](https://github.com/dendenden-boop/tradeGPTbot/pull/35). The merged tree exactly matches source82ea59f, whose full source Platform39481840616/CodeQL39481840847 and PR Platform39481851191/CodeQL39481851145 passed; their artifacts were verified. This does not accept a later main failure.

Exact-main [Platform39550794190](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39550794190) failed audit:dependencies in Ubuntu and Windows. Native PostgreSQL, Auth and Docker jobs were skipped; the real-services aggregate failed. [CodeQL39550794196](https://github.com/dendenden-boop/tradeGPTbot/actions/runs/39550794196) passed. No unchanged-main retry was requested. The failed Ubuntu producer119059284706 artifact12323931531 was verified against exact main SHA, its job window and GitHub SHA256 digest476aa159c8f9b8d5d7fe363c1110ec59073298b2c07232aecf258e3f1f90a4e6; original job logs were retained.

Before any dependency change, the unchanged main lockfile reproduced pnpm audit --json exit1: one HIGH and two MODERATE findings for direct Vite and Vitest/mocker Vite paths. Official advisories mark7.3.6 affected and7.3.7 patched:

- [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm), HIGH: Windows path-existence bypass.
- [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv), MODERATE: Windows command argument escaping.
- [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw), MODERATE: editor CLI flag interpretation.

The prior zero-audit reports reflect their observation times; they are not rewritten or treated as present security guarantees. This is an audit reproduction, not a claim that an application exploit was executed or a trading endpoint was exposed.

## Minimal correction

Pin the official [Vite7.3.7 release](https://github.com/vitejs/vite/releases/tag/v7.3.7) exactly. The npm manifest/integrity was checked before installation. Existing Vitest4.1.11, all other locked versions, Node24.20.0, pnpm11.25.0, minimumReleaseAge1440, allowBuilds, frozen-install policy, audit thresholds and workflow pins remain unchanged. The lockfile changes only Vite version/integrity and existing Vite peer references; there is no override, advisory ignore or suppression.

The same pnpm audit --json after the patch exits0 with no findings at any severity. Source audit RED/GREEN reports and registry integrity evidence are retained in the local checkpoint. No fabricated version-only test or exploit execution substitutes for audit and the real regression suite.

## Acceptance status

Frozen source **0a3d5db0618abf1c621ff2058d919af583064f12** passed all13local format/docs/lint/typecheck/unit/HTTP/schema/build/runtime/twelve-clean/audit commands:4620unit/1386Paper/41HTTP, twelve clean deployments and zero audit findings. All790tracked inputs remained unchanged. Complete4620unit/41HTTP identities match the verified PR35 artifacts; runtime/clean/audit reports were checked against their actual producer-task windows. This accepts those local results, not an unfinished remote run.

The exact final documentation HEAD and subsequent protected main must each pass complete Ubuntu/Windows/native PostgreSQL/real-services/Docker/CodeQL verification. Actual run IDs, job status, artifact SHA256/producer-window/identity checks and publication outcome are tracked in [PR36](https://github.com/dendenden-boop/tradeGPTbot/pull/36). The intermediate0a3d5db source/PR OS jobs passed but the full runs had not completed at this documentation checkpoint; they are not substituted for final-head acceptance. Audit GREEN alone is not full acceptance. All53published migrations, accepted financial runtime/adapters, old assertions and CI deadlines remain unchanged. No new financial migration or PAPER gateway/dispatch is introduced.

**PHASE13 IN_PROGRESS / NOT READY FOR PHASE14.** LIVE/PAPER financial dispatch and positive native collateral credit remain disabled; native AMEND stays Binance Spot TESTNET only. Causal reservation lifecycle, final validation, operational composition and durable virtual execution still require implementation and acceptance. Real private exchange tests, crash/restore recovery and production soak are not claimed.
