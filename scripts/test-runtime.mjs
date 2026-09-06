import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { report, workspace } from './docker-test-utils.mjs';

const startedAt = new Date().toISOString();
const secret = randomBytes(24).toString('hex');
const sockets = new Set();
let maximumSockets = 0;
const blackhole = createServer((socket) => {
  sockets.add(socket);
  maximumSockets = Math.max(maximumSockets, sockets.size);
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  socket.resume();
});
const children = new Set();

async function bind(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback address');
  return address.port;
}

function launch(entrypoint, env, ipc = false) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: workspace,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
  });
  children.add(child);
  let output = '';
  const receive = (chunk) => {
    output += chunk.toString();
    if (output.length > 2_000_000) child.kill('SIGKILL');
  };
  child.stdout.on('data', receive);
  child.stderr.on('data', receive);
  const completed = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Cannot launch compiled API')));
    child.once('close', (code, signal) => {
      children.delete(child);
      resolve({ code, signal });
    });
  });
  return { child, completed, output: () => output };
}

async function deadline(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Runtime test deadline exceeded')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  const dependencyPort = await bind(blackhole);
  const reservation = createServer();
  const apiPort = await bind(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(apiPort),
    LOG_LEVEL: 'info',
    DATABASE_URL: `postgresql://test:${secret}@127.0.0.1:${dependencyPort}/test`,
    REDIS_URL: `redis://:${secret}@127.0.0.1:${dependencyPort}/0`,
    DEPENDENCY_TIMEOUT_MS: '500',
    HEALTH_CACHE_MS: '0',
    SHUTDOWN_TIMEOUT_MS: '2000',
  };
  const invalid = launch('apps/api/dist/server.js', { ...env, PORT: secret });
  assert.equal(
    (await deadline(invalid.completed, 5000)).code,
    1,
    'Invalid config must fail startup',
  );
  assert.ok(invalid.output().includes('CONFIG_INVALID'));
  assert.ok(invalid.output().includes('invalidFields'));
  assert.ok(!invalid.output().includes(secret), 'Startup log leaked credential');

  const windows = process.platform === 'win32';
  const api = launch(
    windows ? 'scripts/runtime-child.mjs' : 'apps/api/dist/server.js',
    env,
    windows,
  );
  const base = `http://127.0.0.1:${apiPort}`;
  const listenDeadline = Date.now() + 5000;
  let live = false;
  while (Date.now() < listenDeadline) {
    try {
      live =
        (await fetch(base + '/health/live', { signal: AbortSignal.timeout(500) })).status === 200;
      if (live) break;
    } catch {
      /* Startup may not have bound its socket yet. */
    }
    await delay(50);
  }
  assert.ok(live, 'Compiled API did not become live');
  assert.equal(maximumSockets, 0, 'Liveness must not open dependency connections');
  const batchStarted = performance.now();
  const responses = await Promise.all(
    Array.from({ length: 64 }, async () => {
      const response = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(1500) });
      assert.equal(response.status, 503);
      const body = await response.text();
      assert.ok(!body.includes(secret), 'Readiness leaked credential');
      assert.deepEqual(JSON.parse(body), {
        status: 'not_ready',
        dependencies: { postgres: 'down', redis: 'down' },
      });
      return response.status;
    }),
  );
  const readinessBatchMs = Math.round(performance.now() - batchStarted);
  assert.ok(readinessBatchMs < 1500, 'Parallel readiness exceeded deadline');
  assert.ok(maximumSockets <= 2, 'Concurrent checks multiplied PostgreSQL/Redis connections');
  assert.equal((await fetch(base + '/health/live')).status, 200);
  const stopStarted = performance.now();
  if (windows) api.child.send('test-sigterm');
  else api.child.kill('SIGTERM');
  assert.equal((await deadline(api.completed, 3000)).code, 0, 'API did not exit cleanly');
  const shutdownMs = Math.round(performance.now() - stopStarted);
  assert.ok(api.output().includes('api_stopped'));
  assert.ok(!api.output().includes(secret), 'Runtime log leaked credential');
  assert.ok(!/uncaught_exception|unhandled_rejection|api_stop_failed/.test(api.output()));
  for (const line of api.output().trim().split('\n')) JSON.parse(line);

  // Exercise the real stdout pipe, not a synthetic stream error. Pino's default
  // destination stops writing after EPIPE; health and shutdown must stay usable.
  const closedSink = launch(
    windows ? 'scripts/runtime-child.mjs' : 'apps/api/dist/server.js',
    env,
    windows,
  );
  const sinkStartupDeadline = Date.now() + 5000;
  let sinkLive = false;
  while (Date.now() < sinkStartupDeadline) {
    try {
      const response = await fetch(base + '/health/live', {
        signal: AbortSignal.timeout(500),
      });
      await response.text();
      sinkLive = response.status === 200 && closedSink.output().includes('api_started');
      if (sinkLive) break;
    } catch {
      /* The new child may not have bound its socket yet. */
    }
    await delay(50);
  }
  assert.ok(sinkLive, 'Closed-sink child did not become live and produce logs');
  await deadline(
    new Promise((resolve) => {
      closedSink.child.stdout.once('close', resolve);
      closedSink.child.stdout.destroy();
    }),
    1000,
  );
  for (let i = 0; i < 16; i++) {
    const response = await fetch(base + '/health/live', {
      signal: AbortSignal.timeout(1000),
    });
    await response.text();
    assert.equal(response.status, 200, 'Closed stdout interrupted liveness');
  }
  const sinkStopStarted = performance.now();
  if (windows) closedSink.child.send('test-sigterm');
  else closedSink.child.kill('SIGTERM');
  assert.equal(
    (await deadline(closedSink.completed, 3000)).code,
    0,
    'Closed stdout prevented clean shutdown',
  );
  const closedSinkShutdownMs = Math.round(performance.now() - sinkStopStarted);
  assert.ok(!closedSink.output().includes(secret), 'Closed-sink diagnostics leaked credential');
  assert.ok(!/uncaught_exception|unhandled_rejection|api_stop_failed/.test(closedSink.output()));
  for (const line of closedSink.output().trim().split('\n')) JSON.parse(line);
  await report('runtime', {
    status: 'PASS',
    startedAt,
    completedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    concurrentReadiness: responses.length,
    maximumDependencySockets: maximumSockets,
    readinessBatchMs,
    shutdownMs,
    closedLogSink: {
      mechanism: 'Parent closes actual child stdout pipe after startup',
      livenessRequestsAfterClose: 16,
      shutdownMs: closedSinkShutdownMs,
      exitCode: 0,
    },
    shutdownMechanism: windows
      ? 'test-only IPC emits registered SIGTERM event; OS signal requires Linux smoke'
      : 'OS SIGTERM',
    dependencies:
      'Real pg/ioredis clients against non-responsive TCP sockets; healthy services require Docker integration',
  });
  console.log(
    'Compiled runtime PASS: fail-fast config, independent liveness, bounded real driver timeouts, concurrency, shutdown and logs.',
  );
} catch (error) {
  const reason =
    error instanceof Error ? error.message.replaceAll(secret, '[REDACTED]') : 'Runtime test failed';
  console.error(reason);
  await report('runtime', { status: 'FAIL', startedAt, reason });
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill('SIGKILL');
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => blackhole.close(resolve));
}
