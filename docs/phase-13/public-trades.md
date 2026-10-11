# Durable public Spot trade evidence

This PHASE 13 increment starts from protected main **b00275ee4fa35da7d7eb8227b9deba357caaf643**. It implements an isolated public trade journal, not certified PAPER Risk admission, shared liquidity allocation, a financial writer or a virtual dispatch worker. Native feed composition and recovery are still outstanding. **PHASE 13 IN PROGRESS / NOT READY FOR PHASE 14**; PAPER dispatch and LIVE remain disabled.

## Identity and ordering

The publication binds exact exchange/region/market/environment, normalized instrument ID, database instrument/rule IDs and the immutable instrument/rules record. Only Spot trades with base quantities are supported. Keys and publications reject unknown fields; native trade IDs and identity scopes are opaque printable ASCII strings of at most 128 characters. Native sequences are canonical integer strings of at most 128 digits and never pass through JavaScript Number. SQL compares them as exact numeric values.

A server publisher supplies a permanent publication UUID and expected durable revision. One bounded transaction locks GLOBAL shared, the public instrument partition and publication UUID, then applies exact replay or CAS. Exact publication replay returns its original durable receipt after proof validation, including after rules replacement; it does not refresh evidence. Changed semantics or cross-instrument publication reuse conflicts. New publications must pass current database rules and a maximum five-second freshness check.

The native identity is partition + identity scope + trade ID, independent of rule replacement. The first native payload and receipt time are retained permanently. Identical native replay under another publication UUID is DUPLICATE: it cannot advance the head, refresh the first receipt time or create another native volume identity. Conflicting reuse creates durable RESYNC_REQUIRED. A distinct trade must preserve its ordering domain and increase native sequence when present; regression, equal sequence or exchange-time regression creates a GAP. Without sequence, distinct trades in the same millisecond are permitted in durable receipt order; the journal does not infer book snapshot semantics or maker priority.

## Proof, freshness and recovery limits

Original publication text/checksum, a separate immutable seal, native identity and monotonic head are retained together. The seal independently retains an indexed native identity: deletion of an older native-seen row after a newer head cannot turn its ID into a new trade. An existing native-seen pointer must match its original sealed publication. Coherent payload/checksum replacement cannot bypass the original seal. Missing retained evidence or a missing head with existing history fails closed. A GAP is sticky across restart, newer publication and metadata replacement. This increment exposes no operation that clears it: verified feed recovery must be implemented separately before production composition.

`head()` returns revision/GAP solely for restart/CAS progress. It is not fresh market evidence, a Portfolio/Risk certificate or execution authority. `read()` verifies the original sealed native publication, exact current key/rules and native/receipt/publication freshness in SQL and again after COMMIT in Node. A lost or ambiguous COMMIT gives MARKET_TRADE_UNCERTAIN without a receipt and without retry; exact durable replay/reconstruction is required.

The writer is an isolated server service, not a client API accepting trusted tenant IDs, URLs or credentials. A checksum is consistency evidence, not authentication. A future certified coordinator must compose the actual server-owned native feed, runtime InstrumentRegistry, current controls and financial scope; this journal cannot certify caller-provided provenance by itself.

## Persistence and operation

Additive migration **202610110001_public_trade_journal** is migration 39; published migrations 1–38 are unchanged. The NOLOGIN group `ctp_market_trade` grants only schema usage and three fixed RPCs: publish, read and head. A dedicated server LOGIN inherits only that group, with no financial/credential table, column, owner, CREATE/TEMP or unrelated function authority. Startup and each RPC independently reject unsafe role graphs and privilege drift.

The port owns at most four physical sockets, rejects a fifth operation with BUSY, and holds a slot until socket close. Abort/deadline destroys the underlying socket; server statement/idle/client-check timeouts also bound work. No pool queue, automatic transaction retry, configurable SQL or arbitrary endpoint override is exposed. Staging/production require verify-full TLS. Close waits for physical closure.

The durable journal is append-only, not a finite in-memory reference registry or LRU cache. Native identities, original seals and heads must survive restart and consistent backup/restore. Both seals and original events have native identity indexes: partial loss of an older native-seen row and its seal cannot erase a retained event or require an unbounded history scan. There is no deletion/compaction policy in this increment; disk capacity must be provisioned and monitored, and unsafe truncation is rejected. Runtime memory is bounded per operation; permanent disk history is an explicit lifecycle obligation. Retention/recovery and bounded shared execution liquidity remain separate PHASE 13 acceptance requirements.

## Verification boundary

RED schema/export tests collected and failed before implementation. Unit contracts cover strict identity/scope/decimal validation, exact large sequences, role/startup and uncertain-COMMIT behavior; real hung TCP tests cover physical handshake abort/deadline. Native PostgreSQL contracts cover concurrency/CAS, restart, duplicates, corruption, sticky GAP, metadata replacement, physical lost COMMIT, hung locks, bounded slots, 300 instruments and isolated roles. Fresh deployment, non-BYPASSRLS owner repetition and populated published-38 upgrade are required. Their actual completed results, failures and CI IDs belong in [verification](verification.md); SQL WASM diagnostics are not native acceptance.
