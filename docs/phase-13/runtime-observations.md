# PAPER runtime observations

This candidate supplies durable evidence for future PAPER certification. It does not implement a certifier, Risk approval, reservations, monetary writes, virtual executor or production probe worker. PHASE 13 remains IN_PROGRESS / NOT READY FOR PHASE 14. LIVE and PAPER financial dispatch stay disabled.

## Scope and provenance

The separate server-only `@ctp/paper-engine/runtime` export provides `createPostgresPaperRuntimeObservations` and `createPostgresPaperRuntimeSource`. The pure package root exposes neither factory. A trusted backend collector calls `context(owner)` before taking probes, receiving the original sealed configuration text hash and current permission/session/account epochs from PostgreSQL. Configuration IDs, exact PAPER tenant/account scope and profile identity must match current server state. Caller URLs, credentials, native private-stream status and generic exchange REST availability are not probe aliases.

Each publication contains all nine dependencies: database, limiter, authentication, publicMarket, executor, clock, latency, rejectRate and maintenance. Each fact has an opaque source ID, original millisecond timestamp and explicit HEALTHY/FAILED/UNKNOWN status. There is no HEALTHY default. Missing actual executor/probes must not be represented by positive fixtures. Production collector composition, authenticated probe acquisition and its operational acceptance are not implemented by this journal.

## Durable ordering and restart

Candidate additive migration 48 stores immutable events, independent immutable seals and one monotonic head per account. Published migrations 1–47 are unchanged. UUID publication IDs are permanent; exact serialized payload replay returns the original receipt without moving the head or renewing timestamps. Reusing an ID with different semantics conflicts. `expectedRevision` is a lossless BIGINT decimal CAS, incrementing from 1. Per-fact time cannot regress; equal time requires an identical entire fact. Observed epochs cannot regress or differ from current server epochs on a new publication.

`find(exactPublication)` explicitly reconciles an uncertain write by original ID/hash/configuration/revision. `head(owner)` returns a retained receipt for producer restart/CAS recovery, even after facts expire or observed epochs change; a receipt is not healthy evidence. Neither operation republishes or retries a mutation. Events/seals/heads are persistent, without LRU eviction, bounded in-memory ID sets or ID reuse after restart. Operational database storage capacity must be managed; no archival/purge or production soak is claimed.

The reader captures only the current head. Missing, corrupt, expired, future or epoch-conflicting evidence fails closed. FAILED/UNKNOWN facts remain explicit `blockedBy` entries; there is no fallback to an older HEALTHY publication. Each fact expires independently at its original timestamp plus the smaller of the configuration evidence age and 5000ms. Reading, replay and publication time never renew a probe. A future coordinator must apply any stricter current Risk policy and combine other evidence coherently in its own certified transaction; joining independently captured objects is not certification.

## Database and physical I/O boundaries

The NOLOGIN observer group can execute only context, publish and receipt lookup RPCs. The NOLOGIN reader can execute only current capture. Runtime logins inherit only their exact group, with schema USAGE and fixed RPC grants; table/column, financial, initializer, mixed-role, schema-owner and extra private-function privileges fail closed. All new tables use FORCE RLS and tenant policies; event/seal mutation, head regression and truncation are denied.

RPCs use GLOBAL shared → tenant exclusive → user/account locks and check current active verified ownership, immutable configuration and SIMULATED PAPER identity without a private connection. Each port owns at most four physical TCP sockets with no waiting queue. Connect, statement, query and total operation bounds are 1s, 2s, 2.5s and at most 3s. Abort/deadline/close destroy the underlying socket. A result is returned only after known COMMIT; ambiguous COMMIT returns UNCERTAIN without automatic retry.

## Verification status

Starting main `b8aa0dcaea9228b310b33515ba6a663377d45344` passed thirteen baseline commands. Factory RED and 101 targeted GREEN contracts are retained locally, including strict scope/content/freshness checks and four physically hung authentication abort/deadline cases. A sandbox temp-file EPERM attempt ran no assertions and is not a semantic RED; the elevated targeted rerun passed. A canonical digest newline contract was already GREEN and is not claimed as a reproduced defect.

A native PostgreSQL test must first establish whether sequential revision 1→2 publication conflicts with the candidate head trigger/UPSERT. Native owner/fresh/upgrade, role graph, full regression and source/PR/protected-main CI are pending. No candidate result here establishes READY FOR PHASE 14, private exchange acceptance, production health or soak.
