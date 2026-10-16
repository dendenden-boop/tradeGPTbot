import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import * as runtime from '../src/runtime.js';
import * as pure from '../src/index.js';
import { runtimeFixture } from './runtime-fixtures.js';

const factory = (
  runtime as unknown as {
    createPostgresPaperRuntimeWorker: (options: unknown) => Promise<unknown>;
  }
).createPostgresPaperRuntimeWorker;

const options = () => ({
  database: { connectionString: 'https://example.invalid', environment: 'test' },
  probes: Object.fromEntries(
    runtime.paperRuntimeDependencies.map((dependency) => [
      dependency,
      runtime.createUnavailablePaperRuntimeProbe(dependency),
    ]),
  ),
  owners: [runtimeFixture().owner],
  intervalMs: 100,
});

it('exports the fixed PostgreSQL worker only through the server runtime subpath', () => {
  expect(factory).toBeTypeOf('function');
  expect('createPostgresPaperRuntimeWorker' in pure).toBe(false);
  expect('createPaperRuntimeWorkerCore' in runtime).toBe(false);
});
it('rejects a missing server-owned PAPER account inventory before database I/O', async () => {
  await expect(factory({ intervalMs: 100 })).rejects.toThrow('PAPER_RUNTIME_WORKER_INPUT');
});
it('rejects caller-supplied collector and health shortcuts before database I/O', async () => {
  await expect(
    factory({ owners: [], intervalMs: 100, collector: {}, health: 'HEALTHY' }),
  ).rejects.toThrow('PAPER_RUNTIME_WORKER_INPUT');
});
it.each([
  'empty',
  'capacity',
  'duplicate',
  'cross-tenant-account',
  'mode',
  'extra-owner-field',
  'invalid-id',
] as const)('rejects %s inventory before opening PostgreSQL', async (fault) => {
  const o = options();
  if (fault === 'empty') o.owners = [];
  if (fault === 'capacity') o.owners = Array.from({ length: 5 }, () => runtimeFixture().owner);
  if (fault === 'duplicate') o.owners.push({ ...o.owners[0]! });
  if (fault === 'cross-tenant-account') o.owners.push({ ...o.owners[0]!, tenantId: randomUUID() });
  if (fault === 'mode') Object.assign(o.owners[0]!, { mode: 'DEMO' });
  if (fault === 'extra-owner-field') Object.assign(o.owners[0]!, { token: 'not-authority' });
  if (fault === 'invalid-id') Object.assign(o.owners[0]!, { accountId: 'invalid' });
  await expect(factory(o)).rejects.toThrow('PAPER_RUNTIME_WORKER_INPUT');
});
it.each([0, 99, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects unsafe scheduling interval %s',
  async (intervalMs) => {
    await expect(factory({ ...options(), intervalMs })).rejects.toThrow(
      'PAPER_RUNTIME_WORKER_INPUT',
    );
  },
);
it.each(['collector', 'store', 'now', 'health', 'signal', 'tenantId', 'permit'])(
  'rejects %s override before PostgreSQL I/O',
  async (key) => {
    await expect(factory({ ...options(), [key]: vi.fn() })).rejects.toThrow(
      'PAPER_RUNTIME_WORKER_INPUT',
    );
  },
);
it.each(['missing', 'extra', 'alias'] as const)(
  'preserves the fixed collector %s probe boundary',
  async (fault) => {
    const o = options();
    if (fault === 'missing') delete o.probes['executor'];
    if (fault === 'extra') Object.assign(o.probes, { health: 'HEALTHY' });
    if (fault === 'alias') o.probes['executor'] = o.probes['database']!;
    await expect(factory(o)).rejects.toThrow('PAPER_RUNTIME_WORKER_INPUT');
  },
);
it.each([
  { connectionString: 'https://example.invalid', environment: 'test' },
  {
    connectionString: 'postgresql://user:private@localhost/db?sslmode=disable',
    environment: 'production',
  },
  {
    connectionString: 'postgresql://user:private@localhost/db?sslmode=require',
    environment: 'production',
  },
])(
  'retains database URL/TLS admission and does not acquire ports on constructor failure ($environment)',
  async (database) => {
    const o = options();
    const probe = o.probes['executor']!;
    const sample = vi.fn(probe.sample),
      close = vi.fn(probe.close);
    o.probes['executor'] = { ...probe, sample, close };
    await expect(factory({ ...o, database })).rejects.toThrow('PAPER_RUNTIME_DATABASE_URL');
    expect(sample).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  },
);
