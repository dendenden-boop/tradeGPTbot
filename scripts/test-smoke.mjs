import { setTimeout as delay } from 'node:timers/promises';
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
  await requireDocker(options);
  await compose(['config', '--quiet']);
  await compose(['pull', 'postgres', 'redis'], { timeoutMs: 600_000 });
  await compose(['build', '--pull'], { timeoutMs: 600_000 });
  resourcesMayExist = true;
  await compose(['up', '-d', '--wait', '--wait-timeout', '60']);
  const port = localPort(await compose(['port', 'api', '3000']));
  const base = `http://127.0.0.1:${port}`;
  await waitStatus(base, 200);
  await waitStatus(base, 200, '/health/live');
  await waitStatus(base, 404, '/api/v1/orders');
  if ((await compose(['exec', '-T', 'api', 'id', '-u'])).trim() === '0')
    throw new Error('API container runs as root');

  for (const dependency of ['postgres', 'redis']) {
    await compose(['stop', '--timeout', '1', dependency]);
    await waitStatus(base, 503);
    await waitStatus(base, 200, '/health/live');
    // API recovery polling also covers startup; no version-specific start --wait flag.
    await compose(['start', dependency]);
    await waitStatus(base, 200);
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
  outcome = { ...outcome, status: 'PASS', imageId, shutdownMs, log: sanitize(logs, test.secrets) };
} catch (error) {
  const message = error instanceof Error ? error.message : 'Smoke runner failed';
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
