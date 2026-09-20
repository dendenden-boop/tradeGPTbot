import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** Same real HTTP/SMTP acceptance flow for compiled Windows/Linux and production Docker image. */
export async function exerciseAuthFlow({ base, origin, readMessages, canaries }) {
  const suffix = randomBytes(8).toString('hex');
  const alice = `alice-${suffix}@ctp.invalid`;
  const bob = `bob-${suffix}@ctp.invalid`;
  const password = `Credential canary ${randomBytes(16).toString('hex')}`;
  const nextPassword = `Reset canary ${randomBytes(16).toString('hex')}`;
  const changedPassword = `Change canary ${randomBytes(16).toString('hex')}`;
  canaries.push(alice, bob, password, nextPassword, changedPassword);
  let requests = 0;
  function browser() {
    const cookies = new Map();
    let csrfToken;
    return {
      snapshot: () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      async request(path, { method = 'GET', body, expected = 200, headers = {} } = {}) {
        const response = await fetch(base + path, {
          method,
          headers: {
            cookie: this.snapshot(),
            ...(method === 'GET'
              ? {}
              : {
                  origin,
                  ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
                }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(8000),
          redirect: 'error',
        });
        requests += 1;
        assert.equal(response.status, expected, `${method} ${path} returned unexpected status`);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const raw = await response.text();
        const result = JSON.parse(raw);
        for (const setCookie of response.headers.getSetCookie()) {
          assert.match(setCookie, /; HttpOnly(?:;|$)/i);
          assert.match(setCookie, /; SameSite=Lax(?:;|$)/i);
          assert.match(setCookie, /; Path=\/(?:;|$)/i);
          assert.doesNotMatch(setCookie, /; Domain=/i);
          const pair = setCookie.split(';', 1)[0];
          const split = pair.indexOf('=');
          const name = pair.slice(0, split);
          const value = pair.slice(split + 1);
          if (value) {
            cookies.set(name, value);
            canaries.push(value, decodeURIComponent(value));
          } else cookies.delete(name);
        }
        if (result.csrfToken) {
          csrfToken = result.csrfToken;
          canaries.push(csrfToken);
        }
        if (expected >= 400) {
          assert.equal(typeof result.error?.code, 'string');
          assert.equal(typeof result.error?.requestId, 'string');
          assert.ok(
            !raw.includes('passwordHash') && !raw.includes('stack'),
            'Unsafe error response',
          );
        }
        return result;
      },
    };
  }
  async function mailToken(recipient, kind, previous = new Set()) {
    const deadline = Date.now() + 6000;
    do {
      for (const message of await readMessages()) {
        if (!message.to.includes(recipient)) continue;
        const decoded = message.raw
          .replace(/=\r?\n/g, '')
          .replace(/=([a-f\d]{2})/gi, (_match, hex) =>
            String.fromCharCode(Number.parseInt(hex, 16)),
          );
        const match = new RegExp(
          `https?://[^\\s<>]+/${kind}#token=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])`,
        ).exec(decoded);
        if (!match || previous.has(match[1])) continue;
        assert.equal(new URL(match[0]).origin, origin, 'Mail link used an untrusted origin');
        canaries.push(match[1]);
        return match[1];
      }
      await delay(50);
    } while (Date.now() < deadline);
    throw new Error(`Local ${kind} email was not delivered`);
  }
  const a = browser();
  const b = browser();
  const a2 = browser();
  const recovery = browser();
  await a.request('/api/v1/auth/csrf'); // Normal same-origin browser GET has no Origin header.
  await a.request('/api/v1/auth/signup', {
    method: 'POST',
    body: { email: alice, password, role: 'ADMIN' },
    expected: 400,
  });
  await a.request('/api/v1/auth/signup', {
    method: 'POST',
    body: { email: alice, password },
    headers: { origin: 'https://foreign.invalid' },
    expected: 403,
  });
  await a.request('/api/v1/auth/signup', {
    method: 'POST',
    body: { email: alice, password },
    headers: { 'x-csrf-token': 'forged' },
    expected: 403,
  });
  await a.request('/api/v1/auth/signup', {
    method: 'POST',
    body: { email: alice, password },
    expected: 202,
  });
  await a.request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: alice, password },
    expected: 401,
  });
  const verifyA = await mailToken(alice, 'verify-email');
  await a.request('/api/v1/auth/verify-email', { method: 'POST', body: { token: verifyA } });
  await a.request('/api/v1/auth/verify-email', {
    method: 'POST',
    body: { token: verifyA },
    expected: 400,
  });
  await a.request('/api/v1/auth/signup', {
    method: 'POST',
    body: { email: alice, password },
    expected: 202,
  });
  const loginA = await a.request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: alice, password },
  });
  const userA = await a.request('/api/v1/users/me');
  assert.ok(
    userA.user.email === alice && userA.user.role === 'USER',
    'Authenticated user mismatch',
  );
  assert.deepEqual(Object.keys(userA.user).sort(), [
    'email',
    'emailVerifiedAt',
    'id',
    'role',
    'status',
  ]);
  await b.request('/api/v1/auth/csrf');
  await b.request('/api/v1/auth/signup', {
    method: 'POST',
    body: { email: bob, password },
    expected: 202,
  });
  await b.request('/api/v1/auth/verify-email', {
    method: 'POST',
    body: { token: await mailToken(bob, 'verify-email') },
  });
  const loginB = await b.request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: bob, password },
  });
  const userB = await b.request('/api/v1/users/me');
  assert.ok(
    userB.user.id !== userA.user.id && userB.user.email === bob,
    'Cross-user identity leak',
  );
  await a.request(`/api/v1/users/me?tenantId=${userB.user.id}`, { expected: 400 });
  await a.request(`/api/v1/auth/sessions/${loginB.session.id}`, {
    method: 'DELETE',
    expected: 404,
  });
  await a2.request('/api/v1/auth/csrf');
  const loginA2 = await a2.request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: alice, password },
  });
  const sessions = await a.request('/api/v1/auth/sessions');
  assert.equal(sessions.sessions.length, 2);
  assert.ok(
    sessions.sessions.every((item) => !('tokenHash' in item) && !('token' in item)),
    'Session list leaked credentials',
  );
  const beforeRotation = a.snapshot();
  const rotated = await a.request('/api/v1/auth/session/rotate', { method: 'POST' });
  assert.equal(
    rotated.session.expiresAt,
    loginA.session.expiresAt,
    'Rotation extended absolute session lifetime',
  );
  await a.request('/api/v1/users/me', { headers: { cookie: beforeRotation }, expected: 401 });
  await a.request(`/api/v1/auth/sessions/${loginA2.session.id}`, { method: 'DELETE' });
  await a2.request('/api/v1/users/me', { expected: 401 });
  await recovery.request('/api/v1/auth/csrf');
  const known = await recovery.request('/api/v1/auth/forgot-password', {
    method: 'POST',
    body: { email: alice },
    expected: 202,
  });
  const unknown = await recovery.request('/api/v1/auth/forgot-password', {
    method: 'POST',
    body: { email: `absent-${suffix}@ctp.invalid` },
    expected: 202,
  });
  assert.deepEqual(known, unknown, 'Account lookup changed the public response');
  const reset = await mailToken(alice, 'reset-password');
  await recovery.request('/api/v1/auth/reset-password', {
    method: 'POST',
    body: { token: reset, password: nextPassword },
  });
  await a.request('/api/v1/users/me', { expected: 401 });
  await recovery.request('/api/v1/auth/reset-password', {
    method: 'POST',
    body: { token: reset, password: nextPassword },
    expected: 400,
  });
  await recovery.request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: alice, password },
    expected: 401,
  });
  await recovery.request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: alice, password: nextPassword },
  });
  await recovery.request('/api/v1/auth/change-password', {
    method: 'POST',
    body: { oldPassword: nextPassword, password: changedPassword },
  });
  await recovery.request('/api/v1/users/me', { expected: 401 });
  await b.request('/api/v1/auth/logout-all', { method: 'POST' });
  await b.request('/api/v1/users/me', { expected: 401 });
  await b.request('/api/v1/auth/login', { method: 'POST', body: { email: bob, password } });
  await b.request('/api/v1/auth/logout', { method: 'POST' });
  await b.request('/api/v1/users/me', { expected: 401 });
  for (let attempt = 0; attempt < 6; attempt++) {
    await b.request('/api/v1/auth/login', {
      method: 'POST',
      body: { email: `limited-${suffix}@ctp.invalid`, password },
      expected: attempt < 5 ? 401 : 429,
    });
  }
  return {
    requests,
    signupAndVerification: 'PASS',
    csrfAndOrigin: 'PASS',
    ownership: 'PASS',
    sessionRotationAndRevocation: 'PASS',
    resetAndChangePassword: 'PASS',
    accountEnumeration: 'PASS',
    rateLimit: 'PASS',
  };
}
