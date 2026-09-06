import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@ctp/config';
import { createLogger } from '@ctp/logger';
import { buildApp } from '../apps/api/src/app.js';
import { createHealthService } from '../apps/api/src/health.js';

const execute = promisify(execFile);
const project = process.env['CTP_TEST_PROJECT'];
if (!project || !/^ctp-integration-\d+-[a-f0-9]{12}$/.test(project)) {
  throw new Error(
    'Run this suite through pnpm test:integration; a fresh owned Docker namespace is required',
  );
}
const testProject: string = project;
const config = loadConfig({ ...process.env, NODE_ENV: 'test', HEALTH_CACHE_MS: '0' });
const app = buildApp({
  config,
  health: createHealthService(config),
  logger: createLogger({ level: 'silent', environment: 'test' }),
});

async function compose(args: string[]): Promise<void> {
  await execute(
    'docker',
    [
      'compose',
      '--env-file',
      '.env.example',
      '-f',
      'infra/compose.test.yml',
      '--project-name',
      testProject,
      ...args,
    ],
    { timeout: 60_000, windowsHide: true },
  );
}

async function waitForStatus(code: number): Promise<void> {
  const deadline = Date.now() + 6500;
  let lastStatus: unknown;
  do {
    const result = await app.inject({ method: 'GET', url: '/health/ready' });
    lastStatus = result.json<unknown>();
    if (result.statusCode === code && Date.now() <= deadline) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(
    `Readiness did not reach ${code} within 6500ms; last status: ${JSON.stringify(lastStatus)}`,
  );
}

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe('real PostgreSQL and Redis lifecycle', () => {
  it('executes SELECT 1 and PING against isolated services', async () => {
    await waitForStatus(200);
    const result = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(result.json<unknown>()).toEqual({
      status: 'ready',
      dependencies: { postgres: 'up', redis: 'up' },
    });
  });

  for (const dependency of ['postgres', 'redis']) {
    it(`fails closed while ${dependency} is stopped and recovers after restart`, async () => {
      await compose(['stop', '--timeout', '1', dependency]);
      try {
        await waitForStatus(503);
        const live = await app.inject({ method: 'GET', url: '/health/live' });
        expect(live.statusCode).toBe(200);
        const response = await app.inject({ method: 'GET', url: '/health/ready' });
        for (const secret of [process.env['POSTGRES_PASSWORD'], process.env['REDIS_PASSWORD']]) {
          if (secret && response.body.includes(secret))
            throw new Error('Readiness leaked credentials');
        }
      } finally {
        // Poll API readiness below, including service startup in the recovery window.
        await compose(['start', dependency]);
      }
      const publishedPort = await execute(
        'docker',
        [
          'compose',
          '--env-file',
          '.env.example',
          '-f',
          'infra/compose.test.yml',
          '--project-name',
          testProject,
          'port',
          dependency,
          dependency === 'postgres' ? '5432' : '6379',
        ],
        { timeout: 10_000, windowsHide: true },
      );
      const expectedPort = new URL(dependency === 'postgres' ? config.databaseUrl : config.redisUrl)
        .port;
      expect(publishedPort.stdout.trim(), 'Dependency host port changed after restart').toBe(
        `127.0.0.1:${expectedPort}`,
      );
      await waitForStatus(200);
    }, 60_000);
  }
});
