import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { exerciseAuthFlow } from './auth-test-flow.mjs';
import { authBrowser } from './auth-http-fixture.mjs';
import {
  composeArgs,
  localPort,
  report,
  requireDocker,
  run,
  sanitize,
  testEnvironment,
} from './docker-test-utils.mjs';

const test = testEnvironment('smoke');
const file = 'infra/compose.dev.yml';
const options = { env: test.env, secrets: test.secrets };
const startedAt = new Date().toISOString();
let resourcesMayExist = false;
let outcome = { status: 'FAIL', startedAt, project: test.project };
const recovery = {};
const compose = (args, extra = {}) =>
  run('docker', composeArgs(file, test.project, args), { ...options, ...extra });

async function waitStatus(base, expected, path = '/health/ready') {
  const deadline = Date.now() + 6500;
  do {
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const response = await fetch(base + path, {
        signal: AbortSignal.timeout(Math.min(1500, remainingMs)),
      });
      const body = await response.text();
      if (test.secrets.some((secret) => body.includes(secret)))
        throw new Error('API response leaked credential canary');
      if (response.status === expected && Date.now() <= deadline) return;
    } catch (error) {
      if (error instanceof Error && error.message.includes('credential canary')) throw error;
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`API did not reach expected HTTP ${expected} at ${path}`);
}

try {
  await report('smoke', { ...outcome, status: 'RUNNING' });
  await requireDocker(options);
  // The public origin must match the actual browser URL, including its port.
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  test.env.API_PORT = String(reservation.address().port);
  test.env.AUTH_ORIGIN = `http://127.0.0.1:${test.env.API_PORT}`;
  await new Promise((resolve) => reservation.close(resolve));
  await compose(['config', '--quiet']);
  console.log('Docker smoke: checking images and building API/local tools.');
  await compose(['pull', 'postgres', 'redis'], { timeoutMs: 600_000 });
  await compose(['build', '--pull'], { timeoutMs: 600_000 });
  resourcesMayExist = true;
  console.log('Docker smoke: starting migrations, limited roles and services.');
  // Request only API and its core dependencies. A mail-sink depends_on gate would
  // start the sink too and fail the email-down assertions below.
  await compose(['up', '-d', '--wait', '--wait-timeout', '60', 'api']);
  const port = localPort(await compose(['port', 'api', '3000']));
  const base = `http://127.0.0.1:${port}`;
  await waitStatus(base, 200);
  await waitStatus(base, 200, '/health/live');
  await waitStatus(base, 404, '/api/v1/orders');
  console.log('Docker smoke: checking SMTP-down boot and recovery without API restart.');
  await waitStatus(base, 503, '/health/auth-email');
  const browser = authBrowser({ base, canaries: test.secrets });
  await browser.request('/api/v1/auth/csrf');
  for (const operation of ['signup', 'resend-verification', 'forgot-password']) {
    await browser.request(`/api/v1/auth/${operation}`, {
      method: 'POST',
      expected: 503,
      body: {
        email: 'smtp-outage@ctp.invalid',
        ...(operation === 'signup' ? { password: 'SMTP outage fixture password' } : {}),
      },
    });
  }
  await waitStatus(base, 200);
  await compose(['up', '-d', '--wait', '--wait-timeout', '60', 'mail-sink']);
  await waitStatus(base, 200, '/health/auth-email');
  const mailPort = localPort(await compose(['port', 'mail-sink', '8025']));
  console.log('Docker smoke: exercising authentication through HTTP and local SMTP.');
  const authentication = await exerciseAuthFlow({
    base,
    origin: test.env.AUTH_ORIGIN,
    canaries: test.secrets,
    readMessages: async () => {
      const response = await fetch(`http://127.0.0.1:${mailPort}/messages`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.status !== 200) throw new Error('Local SMTP sink inspection unavailable');
      return response.json();
    },
  });
  if ((await compose(['exec', '-T', 'api', 'id', '-u'])).trim() === '0')
    throw new Error('API container runs as root');

  for (const dependency of ['postgres', 'redis']) {
    console.log(`Docker smoke: checking ${dependency} outage and recovery.`);
    await compose(['stop', '--timeout', '1', dependency]);
    await waitStatus(base, 503);
    await waitStatus(base, 200, '/health/live');
    // A forced PostgreSQL stop can require crash recovery. The API must stay
    // unavailable until the dependency itself accepts connections. Measure the
    // application's existing 6.5s recovery budget only after that prerequisite.
    const dependencyStarted = Date.now();
    await compose(['up', '-d', '--no-deps', '--wait', '--wait-timeout', '60', dependency]);
    const dependencyReadyMs = Date.now() - dependencyStarted;
    const apiRecoveryStarted = Date.now();
    await waitStatus(base, 200);
    recovery[dependency] = { dependencyReadyMs, apiRecoveryMs: Date.now() - apiRecoveryStarted };
  }
  const stopStarted = Date.now();
  await compose(['stop', '--timeout', '12', 'api']);
  const shutdownMs = Date.now() - stopStarted;
  if (shutdownMs > 10_000) throw new Error('API shutdown exceeded the 10s acceptance budget');
  const container = (await compose(['ps', '-a', '-q', 'api'])).trim();
  const state = JSON.parse(
    await run('docker', ['inspect', '--format', '{{json .State}}', container], options),
  );
  if (state.ExitCode !== 0 || state.OOMKilled)
    throw new Error('API did not exit cleanly after SIGTERM');
  const logs = await compose(['logs', '--no-color', '--no-log-prefix', 'api']);
  if (test.secrets.some((secret) => logs.includes(secret)))
    throw new Error('API logs leaked credential canary');
  if (
    !logs.includes('api_stopped') ||
    /uncaught_exception|unhandled_rejection|api_stop_failed/.test(logs)
  ) {
    throw new Error(
      'API runtime logs contain a fatal lifecycle failure or lack completed shutdown',
    );
  }
  const imageId = (
    await run('docker', ['inspect', '--format', '{{.Image}}', container], options)
  ).trim();
  const image = await run(
    'docker',
    ['image', 'inspect', '--format', '{{json .Config}}', imageId],
    options,
  );
  if (test.secrets.some((secret) => image.includes(secret)))
    throw new Error('Image config contains runtime secrets');
  outcome = {
    ...outcome,
    status: 'PASS',
    imageId,
    shutdownMs,
    authentication,
    smtpBootDownCoreAvailable: true,
    smtpRecoveryWithoutRestart: true,
    recovery,
    log: sanitize(logs, test.secrets),
  };
} catch (error) {
  const message = sanitize(
    error instanceof Error ? error.message : 'Smoke runner failed',
    test.secrets,
  );
  console.error(message);
  outcome = { ...outcome, status: 'FAIL', reason: message };
  process.exitCode = 1;
} finally {
  if (resourcesMayExist) {
    try {
      await compose(['down', '--volumes', '--remove-orphans']);
    } catch {
      console.error(
        `Cleanup failed for owned test project ${test.project}; inspect it before another run.`,
      );
      outcome = { ...outcome, status: 'FAIL', cleanup: 'FAIL' };
      process.exitCode = 1;
    }
  }
  await report('smoke', { ...outcome, completedAt: new Date().toISOString() });
  if (outcome.status === 'PASS')
    console.log(
      'Docker smoke PASS: readiness, real outages/recovery, non-root image, secrets, SIGTERM and logs.',
    );
}
