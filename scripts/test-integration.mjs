import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import {
  composeArgs,
  localPort,
  report,
  requireDocker,
  run,
  testEnvironment,
} from './docker-test-utils.mjs';

const test = testEnvironment('integration');
const file = 'infra/compose.test.yml';
const options = { env: test.env, secrets: test.secrets };
const startedAt = new Date().toISOString();
let resourcesMayExist = false;
let outcome = { status: 'FAIL', startedAt, project: test.project };

async function selectPorts() {
  const reservations = [];
  try {
    for (const field of ['CTP_TEST_POSTGRES_PORT', 'CTP_TEST_REDIS_PORT']) {
      const server = createServer();
      reservations.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
      test.env[field] = String(address.port);
    }
  } finally {
    await Promise.all(
      reservations.map((server) => new Promise((resolve) => server.close(resolve))),
    );
  }
  // Docker fails the run if another process takes a selected port before up.
  // Explicit per-run bindings survive stop/start; Docker's port=0 bindings do not.
}

try {
  await requireDocker(options);
  await selectPorts();
  await run('docker', composeArgs(file, test.project, ['config', '--quiet']), options);
  await run('docker', composeArgs(file, test.project, ['pull', 'postgres', 'redis']), {
    ...options,
    timeoutMs: 600_000,
  });
  resourcesMayExist = true;
  await run(
    'docker',
    composeArgs(file, test.project, ['up', '-d', '--wait', '--wait-timeout', '60']),
    options,
  );
  const postgresPort = localPort(
    await run('docker', composeArgs(file, test.project, ['port', 'postgres', '5432']), options),
  );
  const redisPort = localPort(
    await run('docker', composeArgs(file, test.project, ['port', 'redis', '6379']), options),
  );
  if (!process.argv.includes('--database-only'))
    await run(
      process.execPath,
      [
        fileURLToPath(new URL('./vitest.mjs', import.meta.resolve('vitest/package.json'))),
        'run',
        '--config',
        'vitest.dependencies.config.ts',
      ],
      {
        ...options,
        echo: true,
        env: {
          ...test.env,
          NODE_ENV: 'test',
          CTP_TEST_PROJECT: test.project,
          DATABASE_URL: `postgresql://ctp_test:${test.env.POSTGRES_PASSWORD}@127.0.0.1:${postgresPort}/ctp_test`,
          REDIS_URL: `redis://:${test.env.REDIS_PASSWORD}@127.0.0.1:${redisPort}/0`,
        },
      },
    );
  await run(process.execPath, ['scripts/test-database.mjs'], {
    ...options,
    echo: true,
    timeoutMs: 300000,
    env: {
      ...test.env,
      NODE_ENV: 'test',
      CTP_TEST_PROJECT: test.project,
      DATABASE_MIGRATION_URL: `postgresql://ctp_test:${test.env.POSTGRES_PASSWORD}@127.0.0.1:${postgresPort}/ctp_test`,
    },
  });
  outcome.status = 'PASS';
} catch (error) {
  const message = error instanceof Error ? error.message : 'Integration runner failed';
  console.error(message);
  outcome = { ...outcome, status: 'FAIL', reason: message };
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
      console.error(
        `Cleanup failed for owned test project ${test.project}; inspect it before another run.`,
      );
      outcome = { ...outcome, status: 'FAIL', cleanup: 'FAIL' };
      process.exitCode = 1;
    }
  }
  await report('integration', { ...outcome, completedAt: new Date().toISOString() });
}
