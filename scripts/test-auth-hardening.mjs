import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { createAuthDatabase, createDatabase } from '../packages/database/dist/index.js';
import {
  createAuthService,
  createAuthLimiter,
  createAuthMailer,
  createPasswordHasher,
} from '../packages/auth/dist/index.js';
import { loadConfig, loadAuthConfig } from '../packages/config/dist/index.js';
import { createLogger } from '../packages/logger/dist/index.js';
import { buildApp } from '../apps/api/dist/app.js';
import { createHealthService, databaseReadinessProbe } from '../apps/api/dist/health.js';
import { createMailSink } from './mail-sink.mjs';
import { authBrowser } from './auth-http-fixture.mjs';
import { exerciseEnumeration, exerciseMailCapacity } from './auth-enumeration.mjs';
import { report } from './docker-test-utils.mjs';

if (
  process.env.NODE_ENV !== 'test' ||
  !/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env.CTP_TEST_PROJECT ?? '')
)
  throw new Error('Auth hardening requires the isolated integration runner');
for (const field of ['DATABASE_URL', 'DATABASE_AUTH_URL', 'DATABASE_MIGRATION_URL']) {
  const url = new URL(process.env[field]);
  if (url.hostname !== '127.0.0.1' || !/^\/ctp_p2_fresh_[a-f0-9]{12}$/.test(url.pathname))
    throw new Error('Auth hardening requires an owned disposable database');
}
const redisUrl = new URL(process.env.REDIS_URL);
if (redisUrl.hostname !== '127.0.0.1') throw new Error('Expected isolated Redis');
const { Pool } = createRequire(new URL('../packages/database/package.json', import.meta.url))('pg');
const admin = new Pool({
  connectionString: process.env.DATABASE_MIGRATION_URL,
  max: 1,
  query_timeout: 2000,
});
admin.on('error', () => {});
const startedAt = new Date().toISOString();
const canaries = [
  process.env.DATABASE_URL,
  process.env.DATABASE_AUTH_URL,
  process.env.DATABASE_MIGRATION_URL,
  process.env.REDIS_URL,
];
const cleanup = [];
const measurements = {};
let stage = 'setup',
  outcome = { status: 'FAIL', startedAt };
let sampling = false,
  sampleWork = Promise.resolve(),
  timer;
const peak = {
  authConnections: 0,
  authPoolWaiting: 0,
  authPoolBusy: 0,
  lockWaiters: 0,
  argonRunning: 0,
  argonQueued: 0,
  rssBytes: 0,
};
const lag = monitorEventLoopDelay({ resolution: 10 });
const percentile = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (fraction) =>
    sorted.length ? Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 100) / 100 : 0;
  return { samples: sorted.length, p50: p(0.5), p95: p(0.95), p99: p(0.99) };
};
async function workers(values, concurrency, operation) {
  let index = 0;
  let failed = false;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (!failed && index < values.length) {
        const current = index++;
        try {
          await operation(values[current], current);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}
async function bind(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}
// The delay relay owns every socket/timer; failed Redis operations cannot leave
// background traffic or timers after the test. Credentials are forwarded, never logged.
function redisRelay(target) {
  let delayMs = 0;
  const sockets = new Set(),
    timers = new Set();
  const server = createServer((downstream) => {
    const upstream = createConnection({ host: '127.0.0.1', port: Number(target.port) });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    }
    const relay = (source, destination) =>
      source.on('data', (chunk) => {
        source.pause();
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (destination.destroyed) {
            source.destroy();
            return;
          }
          destination.write(chunk, () => source.resume());
        }, delayMs);
        timers.add(timer);
      });
    relay(downstream, upstream);
    relay(upstream, downstream);
    downstream.once('close', () => upstream.destroy());
    upstream.once('close', () => downstream.destroy());
  });
  return {
    server,
    setDelay: (value) => {
      delayMs = value;
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
try {
  await report('auth-hardening-load', outcome);
  let sink = await createMailSink();
  cleanup.push(() => sink.close());
  const smtpPort = sink.smtpPort;
  const relay = redisRelay(redisUrl);
  cleanup.push(() => relay.close());
  const relayedRedis = new URL(redisUrl);
  relayedRedis.port = String(await bind(relay.server));
  const reservation = createServer(),
    port = await bind(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    AUTH_ORIGIN: base,
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
    REDIS_URL: relayedRedis.href,
    AUTH_CSRF_SECRET: randomBytes(32).toString('hex'),
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtpPort),
    SMTP_SECURE: 'false',
    SMTP_REQUIRE_TLS: 'false',
    SMTP_FROM: 'accounts@ctp.invalid',
  };
  canaries.push(env.AUTH_CSRF_SECRET, relayedRedis.href);
  const config = loadConfig(env),
    authConfig = loadAuthConfig(env, config);
  const repository = await createAuthDatabase({
    connectionString: env.DATABASE_AUTH_URL,
    environment: 'test',
  });
  cleanup.push(() => repository.close());
  const runtime = await createDatabase({ connectionString: env.DATABASE_URL, environment: 'test' });
  cleanup.push(() => runtime.close());
  const hasher = await createPasswordHasher();
  cleanup.push(() => hasher.close());
  const mailer = createAuthMailer({ origin: base, smtp: authConfig.smtp });
  cleanup.push(() => mailer.close());
  const realLimiter = createAuthLimiter(relayedRedis.href);
  cleanup.push(() => realLimiter.close());
  const redisTimes = [];
  const limiter = {
    ...realLimiter,
    async consume(buckets) {
      const t = performance.now();
      try {
        return await realLimiter.consume(buckets);
      } finally {
        redisTimes.push(performance.now() - t);
      }
    },
  };
  const service = createAuthService({
    repository,
    hasher,
    mailer,
    limiter,
    csrfSecret: authConfig.csrfSecret,
  });
  cleanup.push(() => service.close());
  const health = createHealthService(config, databaseReadinessProbe([runtime, repository]));
  cleanup.push(() => health.close());
  let logs = '';
  const logger = createLogger(
    { level: 'info', environment: 'test' },
    {
      write(line) {
        logs += line;
        if (logs.length > 4_000_000) throw new Error('Fixture log bound exceeded');
      },
    },
  );
  const app = buildApp({
    config,
    logger,
    health,
    closeRuntime: () => runtime.close(),
    auth: {
      config: authConfig,
      service,
      readUser: (principal) =>
        runtime.withTenant(principal.userId, (tx) =>
          tx.user.findUniqueOrThrow({
            where: { id: principal.userId },
            select: {
              id: true,
              emailNormalized: true,
              status: true,
              role: true,
              emailVerifiedAt: true,
            },
          }),
        ),
    },
  });
  cleanup.push(() => app.close());
  const password = `Stress credential ${randomBytes(16).toString('hex')}`,
    passwordHash = await hasher.hash(password);
  canaries.push(password, passwordHash);
  stage = 'seed 100 accounts and sessions';
  const suffix = randomBytes(6).toString('hex'),
    accounts = [];
  // Fixture setup uses the real narrow auth repository. It is excluded from HTTP timing.
  for (let i = 0; i < 100; i++) {
    const email = `hardening-${suffix}-${i}@ctp.invalid`,
      verification = randomBytes(32),
      token = randomBytes(32).toString('base64url');
    assert.equal(
      await repository.signup({
        emailNormalized: email,
        passwordHash,
        verificationTokenHash: verification,
      }),
      true,
    );
    assert.equal(await repository.verifyEmail(verification), true);
    const credentials = await repository.credentials(email);
    assert.ok(
      await repository.createSession({
        userId: credentials.userId,
        expectedPasswordHash: passwordHash,
        expectedSessionEpoch: credentials.sessionEpoch,
        tokenHash: createHash('sha256').update(token).digest(),
      }),
    );
    canaries.push(email, token);
    accounts.push({
      email,
      userId: credentials.userId,
      browser: authBrowser({
        base,
        canaries,
        sessionToken: token,
        headers: { 'x-forwarded-for': `198.51.100.${i + 1}` },
      }),
    });
  }
  await app.listen({ host: '127.0.0.1', port });
  await workers(accounts, 8, (account) => account.browser.request('/api/v1/auth/csrf'));
  sampling = true;
  lag.enable();
  const sample = () => {
    const pool = repository.diagnostics(),
      argon = hasher.capacity();
    peak.authConnections = Math.max(peak.authConnections, pool.totalConnections);
    peak.authPoolWaiting = Math.max(peak.authPoolWaiting, pool.waitingRequests);
    peak.authPoolBusy = Math.max(peak.authPoolBusy, pool.totalConnections - pool.idleConnections);
    peak.argonRunning = Math.max(peak.argonRunning, argon.running);
    peak.argonQueued = Math.max(peak.argonQueued, argon.queued);
    peak.rssBytes = Math.max(peak.rssBytes, process.memoryUsage().rss);
  };
  let querying = false;
  timer = setInterval(() => {
    if (!sampling) return;
    sample();
    if (querying) return;
    querying = true;
    sampleWork = admin
      .query(
        "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND application_name='ctp-auth' AND wait_event_type='Lock'",
      )
      .then((result) => {
        peak.lockWaiters = Math.max(peak.lockWaiters, result.rows[0].n);
      })
      .finally(() => {
        querying = false;
      });
    void sampleWork.catch(() => {});
  }, 20);
  async function measure(name, values, concurrency, operation) {
    stage = name;
    const timings = [],
      statuses = {};
    const t = performance.now();
    await workers(values, concurrency, async (value, index) => {
      const start = performance.now();
      const result = await operation(value, index);
      timings.push(performance.now() - start);
      statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    });
    const errors = Object.entries(statuses)
      .filter(([status]) => Number(status) >= 400)
      .reduce((sum, [, count]) => sum + count, 0);
    measurements[name] = {
      durationMs: Math.round(performance.now() - t),
      latencyMs: percentile(timings),
      statuses,
      errorRate: errors / values.length,
    };
  }
  await measure('100 sessions authenticate', accounts, 12, (a) =>
    a.browser.request('/api/v1/users/me'),
  );
  await measure('mixed login me rotate', accounts.slice(0, 24), 6, async (a) => {
    await a.browser.request('/api/v1/auth/login', {
      method: 'POST',
      body: { email: a.email, password },
    });
    await a.browser.request('/api/v1/users/me');
    await a.browser.request('/api/v1/auth/session/rotate', { method: 'POST' });
    return a.browser.request('/api/v1/users/me');
  });
  await measure('one user 50 parallel reads', Array.from({ length: 50 }), 50, () =>
    accounts[99].browser.request('/api/v1/users/me', { expected: [200, 503] }),
  );
  assert.ok(
    measurements['one user 50 parallel reads'].statuses[200] > 0,
    'Parallel reads must admit healthy requests',
  );
  const attack = authBrowser({ base, canaries, headers: { 'x-forwarded-for': '203.0.113.200' } });
  await attack.request('/api/v1/auth/csrf');
  await measure('rate limited attack', Array.from({ length: 100 }), 1, (_value, index) =>
    attack.request('/api/v1/auth/login', {
      method: 'POST',
      body: { email: `attack-${suffix}-${index}@ctp.invalid`, password },
      expected: index < 20 ? 401 : 429,
    }),
  );
  await measure('argon login burst', accounts.slice(50, 70), 20, (a) =>
    a.browser.request('/api/v1/auth/login', {
      method: 'POST',
      body: { email: a.email, password },
      expected: [200, 503],
    }),
  );
  assert.ok(
    measurements['argon login burst'].statuses[200] > 0,
    'Argon burst must admit healthy logins',
  );
  stage = 'native Argon queue overflow';
  const nativeJobs = Array.from({ length: 22 }, () => hasher.verify(null, password));
  const capacity = hasher.capacity();
  sample();
  const nativeResults = await Promise.allSettled(nativeJobs);
  assert.deepEqual(capacity, { running: 2, queued: 8 });
  assert.equal(nativeResults.filter((r) => r.status === 'rejected').length, 12);
  measurements.argonOverflow = { submitted: 22, accepted: 10, rejectedBusy: 12, capacity };
  stage = 'account-independent email capacity';
  measurements.mailCapacity = await exerciseMailCapacity({ base, accounts, canaries });
  stage = 'real account enumeration sample';
  measurements.enumeration = await exerciseEnumeration({
    base,
    admin,
    accounts,
    password,
    canaries,
  });
  stage = 'SMTP degraded';
  // Ensure these 503s exercise the fresh SMTP probe, not the preceding sample's
  // account-independent admission window.
  await delay(5_050);
  await sink.close();
  await accounts[90].browser.request('/health/ready');
  // Email admission bypasses the one-second successful health cache. Assert
  // immediate failure here; a health poll alone may still use that cached proof.
  for (const operation of ['signup', 'resend-verification', 'forgot-password']) {
    await accounts[90].browser.request(`/api/v1/auth/${operation}`, {
      method: 'POST',
      expected: 503,
      body: { email: accounts[90].email, ...(operation === 'signup' ? { password } : {}) },
    });
  }
  await accounts[90].browser.request('/health/auth-email', { expected: 503 });
  await measure('SMTP down authenticated reads', accounts.slice(70, 90), 8, (a) =>
    a.browser.request('/api/v1/users/me'),
  );
  sink = await createMailSink({ smtpPort });
  await accounts[90].browser.request('/health/auth-email');
  measurements.smtpDegraded = {
    coreReady: true,
    mailOperations503: 3,
    recoveredWithoutRestart: true,
  };
  relay.setDelay(120);
  const redisStart = redisTimes.length;
  await measure('Redis 120ms each direction', accounts.slice(25, 35), 5, (a) =>
    a.browser.request('/api/v1/users/me'),
  );
  measurements.redisDelayedOperationsMs = percentile(redisTimes.slice(redisStart));
  relay.setDelay(1500);
  await measure('Redis timeout fail closed', accounts.slice(35, 45), 10, (a) =>
    a.browser.request('/api/v1/users/me', { expected: 503 }),
  );
  relay.setDelay(0);
  await delay(250);
  await accounts[45].browser.request('/api/v1/users/me');
  sampling = false;
  clearInterval(timer);
  await sampleWork;
  lag.disable();
  assert.ok(peak.authConnections <= 3);
  assert.ok(peak.argonRunning <= 2);
  assert.ok(peak.argonQueued <= 8);
  await app.close();
  assert.ok(
    !canaries.filter(Boolean).some((secret) => logs.includes(secret)),
    'Auth stress logs leaked a canary',
  );
  for (const line of logs.trim().split('\n')) JSON.parse(line);
  outcome = {
    status: 'PASS',
    startedAt,
    completedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    users: 100,
    activeSessionsAtStart: 100,
    measurements,
    peak,
    redisOperationMs: percentile(redisTimes),
    eventLoopLagMs: {
      p50: lag.percentile(50) / 1e6,
      p95: lag.percentile(95) / 1e6,
      p99: lag.percentile(99) / 1e6,
      max: lag.max / 1e6,
    },
    maxRssKiB: process.resourceUsage().maxRSS,
    secretFreeLogs: true,
    scope:
      'Controlled loopback acceptance sample; queue/busy diagnostics cover the 3-connection auth pool, not the separate application pool. Not a production throughput or SLO claim. Mixed latency measures four-request sequences. Burst503 records controlled service refusal; each burst must also admit healthy requests.',
  };
  console.log(
    'Auth hardening load PASS: 100 sessions, mixed requests, single-user burst, bounded Argon, SMTP and Redis faults.',
  );
} catch (error) {
  outcome = {
    ...outcome,
    completedAt: new Date().toISOString(),
    measurements,
    peak,
    stage,
    reason: error instanceof Error ? error.message : 'Auth stress failed',
  };
  // Assertions use fixed path/status labels only; never serialize backend error objects.
  console.error(`Auth hardening failed at ${stage}`);
  process.exitCode = 1;
} finally {
  sampling = false;
  clearInterval(timer);
  lag.disable();
  await sampleWork.catch(() => {});
  for (const close of cleanup.reverse())
    await close().catch(() => {
      outcome = { ...outcome, status: 'FAIL', cleanup: 'FAIL' };
      process.exitCode = 1;
    });
  await admin.end().catch(() => {
    outcome = { ...outcome, status: 'FAIL', cleanup: 'FAIL' };
    process.exitCode = 1;
  });
  await report('auth-hardening-load', outcome);
}
