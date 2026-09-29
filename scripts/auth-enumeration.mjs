import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { authBrowser } from './auth-http-fixture.mjs';

// Exercise the documented admission limit separately from timing measurements.
// No retries hide a 503, and no SMTP delivery delay is needed to retain slots.
export async function exerciseMailCapacity({ base, accounts, canaries }) {
  const results = {};
  for (const [index, state] of ['eligible', 'unknown'].entries()) {
    for (const account of accounts.slice(index * 10, index * 10 + 7)) {
      await account.browser.request('/api/v1/auth/forgot-password', {
        method: 'POST',
        expected: 202,
        body: { email: account.email },
      });
    }
    const browser = authBrowser({
      base,
      canaries,
      headers: { 'x-forwarded-for': `192.0.2.${240 + index}` },
    });
    await browser.request('/api/v1/auth/csrf');
    const email =
      state === 'eligible'
        ? accounts[7].email
        : `capacity-${randomBytes(8).toString('hex')}@ctp.invalid`;
    canaries.push(email);
    const target = await browser.request('/api/v1/auth/forgot-password', {
      method: 'POST',
      expected: 202,
      body: { email },
    });
    const probeEmail = `probe-${randomBytes(8).toString('hex')}@ctp.invalid`;
    canaries.push(probeEmail);
    const probe = await browser.request('/api/v1/auth/forgot-password', {
      method: 'POST',
      expected: 503,
      body: { email: probeEmail },
    });
    results[state] = { targetStatus: target.status, probeStatus: probe.status };
    await delay(5_050);
    const recoveryEmail = `recovered-${randomBytes(8).toString('hex')}@ctp.invalid`;
    canaries.push(recoveryEmail);
    const recovered = await browser.request('/api/v1/auth/forgot-password', {
      method: 'POST',
      expected: 202,
      body: { email: recoveryEmail },
    });
    results[state].recoveredStatus = recovered.status;
    // The successful unknown-address recovery also consumes its full slot.
    await delay(5_050);
  }
  assert.deepEqual(results.eligible, results.unknown);
  return {
    states: results,
    reservations: 8,
    holdMs: 5_000,
    scope:
      'Real HTTP, PostgreSQL accounts and SMTP; eligible and unknown targets both retain the eighth slot. Capacity recovers after the fixed window.',
  };
}

/** Real HTTP/Redis/SQL/Argon/SMTP sample; callers own these disposable accounts. */
export async function exerciseEnumeration({ base, admin, accounts, password, canaries }) {
  const [active, pending, suspended, mfa] = accounts.slice(91, 95);
  const writer = await admin.connect();
  try {
    await writer.query('BEGIN');
    await writer.query(
      'SELECT id FROM public."user" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [[pending.userId, suspended.userId, mfa.userId]],
    );
    await writer.query(
      'UPDATE public."user" SET status=\'PENDING_VERIFICATION\',"emailVerifiedAt"=NULL WHERE id=$1',
      [pending.userId],
    );
    await writer.query('UPDATE public."user" SET status=\'SUSPENDED\' WHERE id=$1', [
      suspended.userId,
    ]);
    await writer.query(
      `INSERT INTO public.two_factor_config
      ("tenantId",ciphertext,nonce,tag,"wrappedDek","kmsKeyId","kmsKeyVersion","encryptionVersion","aadVersion","enabledAt","updatedAt")
      VALUES ($1,$2,$3,$4,$2,'fixture-only','1',1,1,now(),now())`,
      [mfa.userId, randomBytes(32), randomBytes(12), randomBytes(16)],
    );
    await writer.query('COMMIT');
  } catch (error) {
    await writer.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    writer.release();
  }
  const descriptors = [
    ['active', active],
    ['pending', pending],
    ['suspended', suspended],
    ['mfa', mfa],
    ['unknown', null],
  ];
  const operations = ['login', 'resend-verification', 'forgot-password', 'signup'];
  const result = {},
    lengths = Object.fromEntries(operations.map((operation) => [operation, new Set()]));
  const fixtures = [];
  const acceptedMailTimes = [];
  for (const [index, [state, account]] of descriptors.entries()) {
    const browser = authBrowser({
      base,
      canaries,
      headers: { 'x-forwarded-for': `192.0.2.${150 + index}` },
    });
    await browser.request('/api/v1/auth/csrf');
    const samples = Object.fromEntries(operations.map((operation) => [operation, []]));
    const statuses = {};
    fixtures.push({ state, account, browser, samples, statuses });
  }
  // Rotate the state order so each state occupies each position once. This
  // avoids treating gradual host load/thermal changes as an account oracle.
  for (let round = 0; round < 5; round++) {
    for (let offset = 0; offset < fixtures.length; offset++) {
      const { account, browser, samples, statuses } = fixtures[(round + offset) % fixtures.length];
      const email = account?.email ?? `unknown-${randomBytes(8).toString('hex')}@ctp.invalid`;
      canaries.push(email);
      // Signup last: every preceding unknown-account operation is actually unknown.
      for (const operation of operations) {
        if (operation !== 'login') {
          // Pace the sample below the public eight-slot/five-second admission
          // limit. Waiting is outside the measured request, independent of state.
          while (acceptedMailTimes.length >= 8) {
            await delay(Math.max(0, acceptedMailTimes[0] + 5_050 - performance.now()));
            while (acceptedMailTimes.length && acceptedMailTimes[0] + 5_050 <= performance.now())
              acceptedMailTimes.shift();
          }
        }
        const started = performance.now();
        const response = await browser.request(`/api/v1/auth/${operation}`, {
          method: 'POST',
          expected: operation === 'login' ? 401 : 202,
          body: {
            email,
            ...(['login', 'signup'].includes(operation)
              ? { password: operation === 'login' ? `${password} wrong` : password }
              : {}),
          },
        });
        samples[operation].push(performance.now() - started);
        if (operation !== 'login') acceptedMailTimes.push(performance.now());
        statuses[operation] = response.status;
        lengths[operation].add(Buffer.byteLength(JSON.stringify(response.body)));
      }
    }
  }
  for (const { state, samples, statuses } of fixtures) {
    result[state] = {
      statuses,
      latencyMs: Object.fromEntries(
        operations.map((operation) => {
          const sorted = [...samples[operation]].sort((a, b) => a - b);
          return [
            operation,
            {
              samples: 5,
              p50: Math.round(sorted[2] * 100) / 100,
              p95: Math.round(sorted[4] * 100) / 100,
              p99: Math.round(sorted[4] * 100) / 100,
              rawMs: samples[operation].map((value) => Math.round(value * 100) / 100),
            },
          ];
        }),
      ),
    };
  }
  for (const operation of operations)
    assert.equal(
      lengths[operation].size,
      1,
      `${operation} response length changed by account state`,
    );
  return {
    states: result,
    responseBytes: Object.fromEntries(
      operations.map((operation) => [operation, [...lengths[operation]][0]]),
    ),
    admissionPacing: { maxAccepted: 8, holdMs: 5_000, excludedFromRequestTiming: true },
    scope:
      'Five raw timing samples per state and operation, rotating state order, real loopback stack. Status and response length equality are asserted; timings require human review and do not establish constant-time network behavior.',
  };
}
