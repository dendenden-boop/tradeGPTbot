# Phase 3: authentication API and assurance boundaries

This document specifies the backend contracts implemented in phase 3. A web interface is scheduled for phase 17. Verification and reset emails already contain real single-use tokens; their `/verify-email#token=…` and `/reset-password#token=…` destinations require that future same-origin interface. Until then, local integration tests use the SMTP test sink and submit the token to the API. The API does not return verification or reset tokens to callers.

## Browser protocol

The configured `AUTH_ORIGIN` is the exact trusted application origin. Begin with `GET /api/v1/auth/csrf` and retain its cookies and JSON `csrfToken`. Same-origin browser GET requests may omit `Origin`; any supplied origin must match, and `Sec-Fetch-Site: cross-site` is rejected. Every mutation requires both that exact `Origin` and an `x-csrf-token` header. A token in a query, body or alternate header is rejected. No CORS policy is enabled.

The CSRF library verifies a signed, HttpOnly cookie and a token bound to either a signed random preauthentication identity or the current opaque session credential. Login, rotation, logout, reset, password change and logout-all issue a fresh CSRF binding. Clients must replace their cached `csrfToken` after those responses; other tabs can obtain a new token with GET. Ordinary CSRF tokens may be reused within the current cookie binding; they are not authentication credentials or single-use recovery tokens.

HTTPS deployments use host-only `__Host-ctp-session`, `__Host-ctp-csrf` and `__Host-ctp-preauth` cookies with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` and no `Domain`. Explicit loopback HTTP development uses the `ctp-dev-` prefix. Session credentials never appear in JSON, URLs or logs. Responses use `Cache-Control: no-store`; the API also emits the phase-1 security headers. Duplicate Origin/CSRF headers, duplicate authentication cookies, oversized cookies and noncanonical session tokens are rejected.

## Routes

All paths below are relative to `/api/v1`. JSON objects reject extra properties and type coercion. All query strings must be empty. Routes without a listed body require no request payload.

| Method and path                  | JSON request                | Success                                               | Session required      |
| -------------------------------- | --------------------------- | ----------------------------------------------------- | --------------------- |
| `GET /auth/csrf`                 | —                           | `200 { csrfToken }`                                   | No                    |
| `POST /auth/signup`              | `{ email, password }`       | `202 { status: "accepted" }`                          | No                    |
| `POST /auth/resend-verification` | `{ email }`                 | `202 { status: "accepted" }`                          | No                    |
| `POST /auth/verify-email`        | `{ token }`                 | `200 { status: "ok" }`                                | No                    |
| `POST /auth/login`               | `{ email, password }`       | `200 { status: "authenticated", csrfToken, session }` | No                    |
| `POST /auth/logout`              | —                           | `200 { status: "ok", csrfToken }`                     | No; idempotent        |
| `POST /auth/forgot-password`     | `{ email }`                 | `202 { status: "accepted" }`                          | No                    |
| `POST /auth/reset-password`      | `{ token, password }`       | `200 { status: "ok", csrfToken }`                     | No                    |
| `POST /auth/change-password`     | `{ oldPassword, password }` | `200 { status: "ok", csrfToken }`                     | Yes                   |
| `GET /auth/sessions`             | —                           | `200 { sessions }`                                    | Yes                   |
| `POST /auth/session/rotate`      | —                           | `200 { status: "authenticated", csrfToken, session }` | Yes                   |
| `DELETE /auth/sessions/:id`      | —                           | `200 { status: "ok" }`                                | Yes, and owned target |
| `POST /auth/logout-all`          | —                           | `200 { status: "ok", csrfToken }`                     | Yes                   |
| `GET /users/me`                  | —                           | `200 { user }`                                        | Yes                   |

The login/rotation `session` contains `id`, `expiresAt` and `idleExpiresAt`. Session listing returns only `id`, `createdAt`, `lastSeenAt`, `idleExpiresAt` and `expiresAt`; all dates are ISO 8601 UTC. It never exposes token hashes, IP hashes, password hashes or MFA data. `/users/me` returns `id`, `email`, `status`, `role` and `emailVerifiedAt` from a tenant-scoped database lookup selected by the validated session. Client-supplied user IDs, tenant IDs and forwarded IP headers cannot select an identity. Deleting the current session invalidates its cookie on the next authenticated request; logout and logout-all also clear the browser cookie immediately.

Supported email addresses use a bounded ASCII mailbox grammar, at most 254 characters and a 64-character local part, then trim surrounding spaces and lowercase the result. Header controls and ambiguous dot/domain syntax are rejected. Passwords contain 15–128 Unicode scalar values and at most 512 UTF-8 bytes. They are neither trimmed nor normalized; unpaired UTF-16 surrogates are rejected. The hashing library produces Argon2id PHC values using 64 MiB memory, three iterations, parallelism one and a random salt. At most two native jobs run with eight queued; rejected or closing requests cannot make the queue grow indefinitely.

## Sessions, recovery and ownership

Session and email credentials contain 32 random bytes encoded as canonical base64url. The database receives only their SHA-256 digests. PostgreSQL time determines session idle expiry (30 minutes), absolute expiry (12 hours), verification expiry (30 minutes) and reset expiry (15 minutes). Session rotation preserves the absolute deadline and makes the previous credential unusable. Login uses a password-hash/session-epoch compare-and-set after Argon2 verification, so a concurrent password reset cannot revive an older credential snapshot.

Verification and reset consumption are atomic and single-use. Successful reset or password change increments the session epoch, revokes all sessions and reset tokens, and revokes LIVE step-up grants in the same transaction. An authenticated user can list or revoke only that user's sessions. The repository repeats ownership and eligibility checks inside its transaction; an earlier HTTP check is not authority for a later write.

Signup, resend and password recovery return the same accepted body for eligible and unknown/duplicate addresses. Login returns the same 401 response for unknown, unverified, inactive, incorrect-password or MFA-required accounts and performs a dummy verification for missing credentials. Password reset does not automatically log in. Invalid, expired or consumed email credentials return generic 400 responses.

SMTP readiness is checked before looking up account eligibility. Delivery is admitted into a bounded in-memory set and occurs after the database transaction. Recipient-specific delivery failure preserves the generic accepted response and emits only a static diagnostic event. A process crash can lose an admitted email; users can request another link. This phase does not claim durable delivery or queue plaintext recovery tokens. Development and tests use a local sink that cannot forward mail; production uses the configured real SMTP transport with verified TLS.

## Errors and abuse limits

Errors retain the phase-1 envelope `{ error: { code, message, requestId } }`. Known auth errors use 400 `BAD_REQUEST`, 401 `UNAUTHENTICATED`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 429 `RATE_LIMITED` and 503 `SERVICE_UNAVAILABLE`. Parser, payload and unexpected failures use the parent application's sanitized handler. SQL, backend errors, credentials and account identifiers are not appended to responses or logs. A foreign or nonexistent target session produces the same 404 result.

Redis admission runs before password work or account lookup. Each source IP has a global 120-per-minute budget, with additional operation budgets: sensitive endpoints allow 20 per IP per 15 minutes and five per identity per 15 minutes where an identity is available. Other operation budgets are 60 per IP and 30 per identity per minute. Password change additionally limits the authenticated account to five attempts per 15 minutes across source IPs. Keys use a server-secret HMAC instead of raw IP addresses, email addresses or token values. Backend and queue failures return 503; Redis failure never grants an unlimited fallback. A 429 response includes a retry hint; retrying may still be limited by another active budget.

## MFA architecture and phase boundaries

The schema separates `TwoFactorConfig`, encrypted TOTP material and hashed recovery-code records from ordinary account/session reads. The auth database role can inspect only MFA eligibility metadata through narrowly owned functions; it cannot read or alter encrypted secrets or recovery codes. Public signup always creates `USER`; callers cannot supply a role or promote an account.

Phase 3 implements the assurance gate, not a pretend TOTP verifier. An `ADMIN` account or an account with enabled, non-revoked MFA cannot obtain or use a password-only session. Both service and database enforce this rule, including existing sessions after policy changes. No enrollment, disabling, recovery-code consumption or bypass endpoint is exposed in this phase.

A future MFA implementation must add an explicit pending-authentication challenge after password verification, short expiry and bounded attempts, encrypted TOTP secret access through the KMS boundary, replay-resistant time-step verification, atomic single-use recovery-code consumption, and a successful second-factor transition before session issuance. Enrollment/disable/secret rotation need recent authentication and revocation rules. LIVE step-up remains a separate assurance decision; normal login cannot mint a LIVE grant. Until these transitions exist and their security tests pass, the current gate stays closed for MFA-required accounts.

Account deletion and the phase-17 web interface remain separate scheduled work. Phase-3 acceptance is the backend signup, email verification, login/logout, recovery, password change, session management and the MFA architecture above. HTTP socket tests validate cookie/Origin/CSRF/schema/error contracts with controlled service doubles; database tests and compiled-server SMTP integration separately validate persistence, role grants, replay, races and full composition.
