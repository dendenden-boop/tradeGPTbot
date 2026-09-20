import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createMailSink } from './mail-sink.mjs';
import { exerciseAuthFlow } from './auth-test-flow.mjs';
import { report, sanitize, workspace } from './docker-test-utils.mjs';

if (
  process.env.NODE_ENV !== 'test' ||
  !/^ctp-integration-\d+-[a-f0-9]{12}$/.test(process.env.CTP_TEST_PROJECT ?? '')
) {
  throw new Error('Auth runtime requires the isolated integration runner');
}
for (const field of ['DATABASE_URL', 'DATABASE_AUTH_URL']) {
  const url = new URL(process.env[field]);
  if (url.hostname !== '127.0.0.1' || !/^\/ctp_p2_fresh_[a-f0-9]{12}$/.test(url.pathname))
    throw new Error('Auth runtime requires an owned disposable database');
}
const startedAt = new Date().toISOString();
const canaries = [
  'DATABASE_URL',
  'DATABASE_AUTH_URL',
  'DATABASE_MIGRATION_URL',
  'REDIS_URL',
].flatMap((field) =>
  process.env[field] ? [process.env[field], new URL(process.env[field]).password] : [],
);
const children = new Set();
const diagnostics = [];
let sink;
let stage = 'setup';
let outcome = { status: 'FAIL', startedAt, platform: process.platform };
const windows = process.platform === 'win32';
const launch = (env, bridge = windows) => {
  const child = spawn(
    process.execPath,
    [bridge ? 'scripts/auth-runtime-child.mjs' : 'apps/api/dist/server.js'],
    {
      cwd: workspace,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', ...(bridge ? ['ipc'] : [])],
    },
  );
  children.add(child);
  let output = '';
  const receive = (data) => {
    output += data.toString();
    if (output.length > 2_000_000) child.kill('SIGKILL');
  };
  child.stdout.on('data', receive);
  child.stderr.on('data', receive);
  const completed = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Cannot launch authenticated API')));
    child.once('close', (code) => {
      children.delete(child);
      resolve(code);
    });
  });
  const handle = { child, completed, output: () => output };
  diagnostics.push(handle);
  return handle;
};
async function deadline(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Auth runtime deadline exceeded')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  sink = await createMailSink();
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const csrfSecret = randomBytes(32).toString('hex');
  canaries.push(csrfSecret);
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    AUTH_ORIGIN: base,
    AUTH_CSRF_SECRET: csrfSecret,
    LOG_LEVEL: 'info',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(sink.smtpPort),
    SMTP_SECURE: 'false',
    SMTP_REQUIRE_TLS: 'false',
    SMTP_FROM: 'accounts@ctp.invalid',
  };
  // Configuration may be syntactically valid while the DB role is unsafe. No listen is permitted.
  stage = 'unsafe-role startup';
  // A startup failure needs no signal bridge. Avoid racing IPC disconnect with module loading.
  const unsafe = launch({ ...env, DATABASE_URL: process.env.DATABASE_MIGRATION_URL }, false);
  assert.equal(await deadline(unsafe.completed, 8000), 1, 'Migration role was accepted by runtime');
  assert.ok(!unsafe.output().includes('api_started'), 'Unsafe runtime role opened the listener');
  stage = 'authenticated startup';
  const api = launch(env);
  const readyDeadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    try {
      const response = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(1000) });
      await response.text();
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* Startup has not bound its listener yet. */
    }
    if (!children.has(api.child)) break;
    await delay(50);
  }
  assert.ok(ready, `Authenticated API startup failed: ${sanitize(api.output(), canaries)}`);
  stage = 'HTTP and SMTP flow';
  const flow = await exerciseAuthFlow({
    base,
    origin: base,
    readMessages: () => sink.messages,
    canaries,
  });
  stage = 'shutdown';
  const stopStarted = Date.now();
  if (windows) api.child.send('test-sigterm');
  else api.child.kill('SIGTERM');
  assert.equal(
    await deadline(api.completed, 10_000),
    0,
    'Authenticated API did not shut down cleanly',
  );
  const shutdownMs = Date.now() - stopStarted;
  const output = unsafe.output() + api.output();
  assert.ok(
    !canaries.filter(Boolean).some((secret) => output.includes(secret)),
    'Authentication logs leaked a secret or account canary',
  );
  assert.ok(api.output().includes('api_stopped'));
  assert.ok(
    !/uncaught_exception|unhandled_rejection|api_stop_failed|auth_mail_delivery_failed/.test(
      api.output(),
    ),
  );
  for (const line of output.trim().split('\n')) JSON.parse(line);
  outcome = {
    ...outcome,
    status: 'PASS',
    ...flow,
    shutdownMs,
    unsafeMigrationRoleRejected: true,
    realDependencies: ['PostgreSQL', 'Redis', 'SMTP sink', 'Argon2id'],
    secretFreeLogs: true,
  };
  console.log(
    'Authenticated compiled runtime PASS: real SQL, Redis, Argon2id, SMTP, CSRF, ownership, sessions and credential recovery.',
  );
} catch (error) {
  const reason = sanitize(
    error instanceof Error ? error.message : 'Auth runtime failed',
    canaries.filter(Boolean),
  );
  console.error(`${stage}: ${reason}`);
  outcome.reason = reason;
  outcome.stage = stage;
  outcome.diagnostics = diagnostics.map((handle) =>
    sanitize(handle.output(), canaries.filter(Boolean)),
  );
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill('SIGKILL');
  await sink?.close();
  await report('auth-runtime', { ...outcome, completedAt: new Date().toISOString() });
}
