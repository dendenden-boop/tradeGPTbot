# PHASE 7 — Dependencies and packaging

OKX reuses pinned Node 24.20.0, pnpm 11.25.0, workspace Exchange Core, Zod 4.5.4, ws 8.22.0 (MIT) and development-only @types/ws 8.18.2 (MIT). The lockfile adds only one workspace importer, with no existing dependency version/integrity changes, SDK, retry layer or release-age exception. Audit results are recorded in [verification](verification.md).

The accepted bounded native HTTP/WS and lossless wire primitives are copied into the new adapter and tested with real sockets. Existing Core/Binance/Bybit sources remain unchanged. This preserves completed phases while keeping OKX protocol signing, passphrase, native DTOs and guards local. Any future shared transport extraction requires a separate compatibility gate.

The only production runtime export is createOkxAdapter. Raw IO, signer, profiles and injectable test assembly have no package subpath exports. Production deployment excludes source/test/dev tools, is resolved independently under a frozen lockfile and has no import/construction side effects. The existing clean-install acceptance now verifies six deployments: API, database, Exchange Core, Binance, Bybit and OKX. Published migrations remain unchanged.

Credentials, enrollment permissions, atomic rates, Demo grants, authorization, identities and order admission remain mandatory trusted server ports where applicable. No default port authorizes trading. Manual pnpm probe:okx allows only bounded official public REST/WS operations, never accepts CLI destinations and records sanitized output. Real private acceptance is not authorized; LIVE mutations remain disabled.
