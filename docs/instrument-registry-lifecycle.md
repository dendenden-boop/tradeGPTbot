# InstrumentRegistry lifecycle hardening

Gate: **NOT READY FOR PHASE 8 — full regression/CI pending**. Baseline clean main `bba87005ccb087fe6065ba0510e31b5bf8a7b3b4`; previous PHASE 5–7 contracts and PHASE 7 acceptance read. This task fixes one reproduced cross-adapter lifecycle defect. PHASE 8 is not started. Published migrations, Risk/authorization/order contracts and native exchange protocols are outside the change.

## Reproduction and decision

Binance, Bybit and OKX factories implicitly created `createInstrumentRegistry({ capacity: symbols.length, versionCapacity: 100000 })`. The reference implementation correctly retains historical rules/metadata IDs to forbid reuse, while each actual native metadata observation creates new immutable versions even for unchanged constraints. At 300 instruments, each refresh spends 600 IDs: 166 complete refreshes spend 99,600; the 167th accepts 200 instruments, then returns BUSY. The remaining previously accepted records have expired. Increasing the budget or evicting historical IDs does not solve the lifecycle contract.

Three RED tests precede the fix: each native Binance/Bybit/OKX normalizer supplies 300 unchanged instruments through repeated refreshes. All reproduce 50,000 accepted puts followed by BUSY at zero-based refresh 166/instrument 200 and STALE_METADATA on the expired record; the production factory incorrectly accepts a missing runtime dependency. Evidence: ignored `test-results/registry-runtime-before.json` and log. This is a shared pattern, not an OKX-specific defect.

Chosen solution: mandatory server-injected `RuntimeInstrumentRegistry` for all three production factories, at both TypeScript and runtime configuration boundaries. No default registry exists in either production or internal assembly. Absent/incomplete get/put ports throw the existing INVALID_*_CONFIGURATION error before exchange operations. Adapters use the supplied instance directly; disconnect/recreation never clears or owns its history.

## Reference and runtime contracts

Exchange Core adds only named writable/runtime/reference interfaces; the existing read-only InstrumentRegistry, synchronous get/put result shapes and reference behavior remain compatible. Each adapter keeps its previous WritableInstrumentRegistry type name as a compatibility interface for explicit transport fixtures. Factory options now require registry; callers that relied on the default must supply the trusted server port.

`createInstrumentRegistry()` returns a ReferenceInstrumentRegistry. It is a finite, process-local test/reference implementation: records 1–10,000; historical version IDs 2–100,000; BUSY before capacity overflow; no history eviction, version reuse or persistence. An identical current record remains idempotent. A new reference instance intentionally has no restart history and cannot be used as runtime recovery.

RuntimeInstrumentRegistry is a trusted structural port, not an attestation mechanism. Factory validation checks methods; it cannot certify another service's durability. A server composer must provide and verify these obligations before production use:

- Own the registry independently of adapter instances, process-local metadata caches and connections. Scope keys by exchange/region/market/environment/instrument; tenant credentials never determine public instrument identity.
- Accept native opaque version IDs. Validate immutable content, matching instrument/rules scope, stable symbol ownership, effectiveAt monotonicity and freshness. Atomically publish the current record and persist rules/metadata anti-reuse history before acknowledging successful put.
- Reject historical rules or metadata IDs after intervening versions, including A→B→A with unchanged economics, after expiry, compaction, failover and restart. Identical current records remain idempotent. Do not reclaim capacity by forgetting IDs; lexicographically comparing native opaque IDs is not a generation protocol.
- Bound the in-memory current-record/cache footprint. Preserve uniqueness history durably, or use an explicitly proven non-reuse generation protocol compatible with the adapter's native observation IDs. Storage quota, recovery, concurrency and latency budgets belong to the runtime owner and require independent acceptance for 300+ instruments and sustained operation.
- Recover current records and the complete anti-reuse evidence before serving operations. A latest-record-only snapshot or a new empty reference registry is insufficient. Corrupt, incomplete or unavailable history fails closed; it must never silently become a fresh writable registry.
- Preserve the synchronous interface: do not return a Promise or successful result before durable commit. Serialize/atomically commit concurrent puts; failure must not partially replace the accepted record/history. Existing Result errors remain authoritative; storage/recovery failures cannot authorize stale metadata or new risk.

No durable production registry service, database schema or new storage implementation is shipped by this fix. It removes the unsafe implicit composition and makes lifecycle ownership explicit, as required by the preferred solution. Injecting a reference fixture is explicit diagnostic/test composition only; its structural assignability is not proof that runtime obligations are satisfied. Application runtime composition and durable market-data services remain later roadmap scope.

## Regression and verification

The shared lifecycle suite verifies all three production exports reject absent/incomplete ports. Real native protocol fixtures exercise 180 sequential metadata refreshes for 300 symbols through each adapter's internal assembly using an explicit owner: 54,000 puts / 108,000 IDs, above the old global budget; both pages consumed; getSymbolInfo uses current metadata; recreating the adapter after 90 refreshes retains the injected owner. Private reads remain AUTHORIZATION_REQUIRED without server connection; registry injection grants no trading authority.

The long-run owner is a test contract driver built from per-identity finite reference stores, not a claimed runtime storage solution or real exchange load test. Separate small file-journal contract drivers acknowledge after append/fsync, validate before publishing, recover all accepted versions on reopen, reject independent rules/metadata A→B→A, retain B after rejection, and reject a corrupt journal rather than recovering empty. These fixtures are not exported, packaged, or used as production defaults.

Existing anti-reuse, atomic-capacity, immutable-content, metadata-expiry, order/risk/auth, no LIVE mutations and UNKNOWN/no-blind-retry tests remain required. Bounded public diagnostic scripts and packaging tests explicitly inject finite reference fixtures; they do not claim runtime persistence or long-running readiness. No new live/private exchange acceptance is performed.

2026-10-04 local acceptance: format:check, docs:check, lint, typecheck, test:unit, test:http, build, db:validate, test:runtime, test:clean and pnpm audit --json all exit 0. **2002 unit + 41 HTTP tests passed, zero failures/skips**, including all **12 new lifecycle tests** and the existing order/risk/auth regression. Six isolated production deployments PASS; deployed factories reject missing registry and accept explicit fixtures. Audit is zero at every severity (407 dependencies); lockfile SHA256 remains `537d6723736354db25afc867bd2dec4e4031aceaba8b7031c0bcc5602eb9a11d`. Ignored evidence: registry-final checks, unit, HTTP, clean, audit and registry-contract-final reports.

Full CI for this correction is pending. Until then the gate remains NOT READY FOR PHASE 8.
