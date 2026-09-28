import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import {
  composeArgs,
  localPort,
  report,
  requireDocker,
  run,
  testEnvironment,
} from './docker-test-utils.mjs';

// Own one isolated Redis service. Never reuse or clear a developer's database.
const test = testEnvironment('integration');
const file = 'infra/compose.test.yml';
const options = { env: test.env, secrets: test.secrets };
let resourcesMayExist = false;
let outcome = { status: 'FAIL', startedAt: new Date().toISOString(), project: test.project };
try {
  await requireDocker(options);
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
  test.env.CTP_TEST_REDIS_PORT = String(address.port);
  test.env.CTP_TEST_POSTGRES_PORT = '1'; // Required Compose interpolation; PostgreSQL is not started.
  await new Promise((resolve) => reservation.close(resolve));
  resourcesMayExist = true;
  await run(
    'docker',
    composeArgs(file, test.project, [
      'up',
      '-d',
      '--pull',
      'missing',
      '--wait',
      '--wait-timeout',
      '60',
      'redis',
    ]),
    options,
  );
  const port = localPort(
    await run('docker', composeArgs(file, test.project, ['port', 'redis', '6379']), options),
  );
  await run(
    process.execPath,
    [
      fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
      'run',
      '--config',
      'vitest.database.config.ts',
      'packages/auth/test/rate-limit.integration.test.ts',
      'packages/auth/test/rate-limit-hardening.integration.test.ts',
      '--outputFile',
      'test-results/auth-limiter-tests.json',
    ],
    {
      ...options,
      echo: true,
      timeoutMs: 120_000,
      env: {
        ...test.env,
        NODE_ENV: 'test',
        CTP_TEST_PROJECT: test.project,
        REDIS_URL: `redis://:${test.env.REDIS_PASSWORD}@127.0.0.1:${port}/0`,
      },
    },
  );
  const results = JSON.parse(await readFile('test-results/auth-limiter-tests.json', 'utf8'));
  if (!results.success) throw new Error('Auth limiter regression tests failed');
  outcome = { ...outcome, status: 'PASS', tests: results.numPassedTests };
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Auth limiter tests failed');
  process.exitCode = 1;
} finally {
  if (resourcesMayExist) {
    try {
      await run(
        'docker',
        composeArgs(file, test.project, ['down', '--volumes', '--remove-orphans']),
        options,
      );
    } catch {
      outcome = { ...outcome, status: 'FAIL', cleanup: 'FAIL' };
      process.exitCode = 1;
    }
  }
  await report('auth-limiter', { ...outcome, completedAt: new Date().toISOString() });
}
