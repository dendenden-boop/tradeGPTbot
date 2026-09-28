import assert from 'node:assert/strict';

/** Test-only browser cookie jar. Callers own a disposable loopback API. */
export function authBrowser({ base, canaries, headers = {}, sessionToken }) {
  const cookies = new Map(sessionToken ? [['ctp-dev-session', sessionToken]] : []);
  if (sessionToken) canaries.push(sessionToken);
  let csrfToken;
  return {
    snapshot: () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
    async request(path, { method = 'GET', body, expected = 200 } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...headers,
          cookie: this.snapshot(),
          ...(method === 'GET' ? {} : { origin: base, 'x-csrf-token': csrfToken ?? '' }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      const raw = await response.text();
      assert.ok(
        (Array.isArray(expected) ? expected : [expected]).includes(response.status),
        `${method} ${path} expected ${expected}, received ${response.status}`,
      );
      assert.equal(response.headers.get('cache-control'), 'no-store');
      for (const setCookie of response.headers.getSetCookie()) {
        assert.match(setCookie, /; HttpOnly(?:;|$)/i);
        assert.match(setCookie, /; SameSite=Lax(?:;|$)/i);
        assert.match(setCookie, /; Path=\/(?:;|$)/i);
        assert.doesNotMatch(setCookie, /; Domain=/i);
        const pair = setCookie.split(';', 1)[0];
        const split = pair.indexOf('=');
        const name = pair.slice(0, split),
          value = pair.slice(split + 1);
        if (value) {
          cookies.set(name, value);
          canaries.push(value, decodeURIComponent(value));
        } else cookies.delete(name);
      }
      const result = JSON.parse(raw);
      if (result.csrfToken) {
        csrfToken = result.csrfToken;
        canaries.push(csrfToken);
      }
      return { status: response.status, body: result, headers: response.headers };
    },
  };
}
