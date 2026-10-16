# PAPER runtime collector

## Authority and scope

`createPostgresPaperRuntimeCollector` is a server-only export of `@ctp/paper-engine/runtime`. It opens the existing fixed-role PostgreSQL observer. The pure root exposes neither this factory nor probe construction. There is no public reference persistence, caller-selected store/observer/clock, HTTP endpoint, financial writer, certificate, Risk approval, reservation or permit.

The server must provide nine distinct, exclusively owned probe ports: database, limiter, authentication, publicMarket, executor, clock, latency, rejectRate and maintenance. Their exact method bindings are captured at construction. A request body or serialized health object is not a probe. The authenticated server inventory owns the target PAPER tenant/account; the existing SQL boundary independently checks current active verified ownership and sealed configuration. Tenant/account UUIDs alone are not authentication credentials.

Every probe receives the current immutable database context, a composed AbortSignal and the remaining absolute deadline. Its strict result must identify its dependency, the exact context hash and the original fact with opaque non-secret source ID, timestamp and explicit HEALTHY/FAILED/UNKNOWN status. Facts older than the acquired context, future facts, mismatched context/epoch, missing fields and unsupported fields reject the entire cycle before publication. Timestamps are never renewed during validation or publication. A context hash binds content; it does not prove service health or grant authority after serialization.

`createUnavailablePaperRuntimeProbe` explicitly records UNKNOWN for a component which has no implementation or operational evidence. Missing configuration rejects construction; it never creates an implicit HEALTHY/default sensor. FAILED and UNKNOWN facts are published unchanged. PUBLISHED means only that the observation journal committed, including negative facts; it is not readiness. The accepted reader preserves `blockedBy` and original expiry.

Actual application sensor wiring, authenticated operational acquisition and periodic worker scheduling remain separate work. In particular, the absent virtual executor cannot be represented by a positive fixture. Test probes do not establish production operational health, real exchange acceptance or soak.

## Ordering, restart and unknown publication

Each independent collection reads the retained durable head, then current context, acquires all nine fresh facts and publishes once using that head's lossless BIGINT revision. PostgreSQL rechecks current epochs/configuration and performs the existing CAS/ordering checks. Concurrent collector instances cannot both advance the same expected revision. A conflict or current epoch rejection is surfaced without retries.

No lifetime IDs or ordering watermarks are held in a bounded reference registry. Restart reads the existing journal head and takes new probes; it neither resets revision to zero nor reuses previously sampled health under a new context. Published migrations 1–48 and the journal's permanent publication IDs, seals, RLS, locks and anti-reuse invariants are unchanged.

The result contains the exact immutable original publication. A lost/ambiguous dispatch acknowledgement, abort after publication starts, corrupt receipt or expiry during receipt validation yields UNCERTAIN without a replacement publication or result grant. The server retains the original publication for explicit `reconcile(publication, io)`, which performs lookup only and validates the original ID/hash/revision/configuration/owner. No publish/probe retry occurs. An expired original receipt can be reconciled without renewing its facts or claiming healthy evidence.

A collector crash may leave no caller-held original publication. The durable journal still retains any committed event/head; a later independent cycle takes new probes from that head. This is not a claim that the missing caller result was resolved. Exact reconciliation requires the original retained publication. No financial effect exists to duplicate or release, and this API must not be reused as Order/Risk recovery.

## Physical lifecycle and limits

At most four account flights are admitted, with one in-flight operation per exact PAPER account and no waiting queue. A cycle owns at most nine concurrent probe operations. One absolute deadline, bounded by 3000ms, caller deadline and acquired context expiry, covers head/context, all probes and publication. The existing observer transport retains its physical socket/SQL bounds. A final validation check prevents PUBLISHED after the cycle deadline even when receipt processing crosses that boundary.

Caller abort/deadline cancels the composed signal, but does not free an account slot while an underlying promise remains unsettled. Late rejections remain observed. The fixed-capacity pending map stores active operations only, never historical IDs; completed cycles release it. The trusted probe contract requires physical settlement on abort/deadline/close. A broken/hung port cannot create an unbounded queue or silently restore admission.

Successful factory construction transfers ownership of all nine ports to the collector. `close()` is idempotent, cancels active cycles, closes the observer and probes, and waits for actual pending settlement within a 3000ms close bound. A port that cannot close causes CLOSE_FAILED and admission remains closed; this is not a claim that arbitrary misbehaving JavaScript can be forcibly terminated. A failed constructor does not assume ownership of pre-created server ports.

## Verification boundary

Starting main **c1db3edb291c6a404e2c451e39388a58b1188a8d** passed all thirteen baseline commands before implementation. Three executable missing-implementation RED contracts became GREEN. Further RED proved a corrupt receipt was misclassified after dispatch, a result could be PUBLISHED after receipt validation consumed the remaining deadline, and a hidden required port plus an unknown enumerable key could pass key-count validation. Each fix has a regression contract; construction now requires the exact nine enumerable dependency keys. Sixty-three new unit contracts pass, covering context provenance, negative facts, unknown/reconciliation, restart, bounded pending work/close, capacity and 300 fresh cycles.

A first recovery test accidentally returned its old captured context on the next cycle and correctly rejected PROBE; its fixture was corrected to acquire a fresh fact. Type/mock/lint repairs and an automatic approval-review usage-limit failure are tooling/fixture issues, not product RED. The review failure executed no tests and was resolved through the same approval mechanism.

Five real PostgreSQL contracts are added to the existing runtime suite, repeated under the non-BYPASSRLS owner: restart/negative executor without monetary writes, physically lost server COMMIT with exact restart reconciliation, current epoch replacement, concurrent collector CAS and abort of blocked head acquisition. Native results, full regression and complete Ubuntu/Windows/real-services/Docker/CodeQL acceptance remain pending. No local native PostgreSQL/Docker execution is claimed. No deadline, workflow, security check, published migration or native financial/adapter behavior is changed.

**PHASE 13 IN_PROGRESS / NOT READY FOR PHASE 14**. Complete certified PAPER capture, tenant exposure/loss/capabilities, atomic vector reservations/Portfolio holds, final validation and virtual execution remain outstanding. LIVE/PAPER financial dispatch and positive native collateral credit stay disabled; native AMEND remains Binance Spot TESTNET only.
