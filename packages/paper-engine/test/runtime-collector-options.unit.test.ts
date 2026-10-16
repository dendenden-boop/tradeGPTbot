import { expect, it, vi } from 'vitest';
import * as runtime from '../src/runtime.js';
import * as pure from '../src/index.js';
import type { PaperRuntimeCollectorOptions } from '../src/runtime-collector.js';
import type { PaperRuntimeProbes } from '../src/runtime-collector-core.js';

const probes = () =>
  Object.fromEntries(
    runtime.paperRuntimeDependencies.map((d) => [d, runtime.createUnavailablePaperRuntimeProbe(d)]),
  ) as unknown as PaperRuntimeProbes;
const database = { connectionString: 'https://example.invalid', environment: 'test' as const };

it('exports only the PostgreSQL collector and explicit negative probe on the server subpath', () => {
  expect(runtime.createPostgresPaperRuntimeCollector).toBeTypeOf('function');
  expect(runtime.createUnavailablePaperRuntimeProbe).toBeTypeOf('function');
  for (const name of [
    'createPostgresPaperRuntimeCollector',
    'createUnavailablePaperRuntimeProbe',
    'createPaperRuntimeCollectorCore',
    'bindPaperRuntimeProbes',
    'approve',
    'reserve',
    'permit',
    'execute',
  ]) {
    expect(name in pure).toBe(false);
    if (!name.startsWith('createPostgres') && name !== 'createUnavailablePaperRuntimeProbe')
      expect(name in runtime).toBe(false);
  }
});

it.each(['missing', 'extra', 'hidden-extra', 'alias', 'dependency', 'sample', 'close'] as const)(
  'rejects %s probe configuration before database or sample I/O',
  async (fault) => {
    const ports = { ...probes() } as Record<string, unknown>;
    if (fault === 'missing') delete ports['executor'];
    if (fault === 'extra') ports['health'] = 'HEALTHY';
    if (fault === 'hidden-extra') {
      Object.defineProperty(ports, 'executor', { value: ports['executor'], enumerable: false });
      ports['health'] = 'HEALTHY';
    }
    if (fault === 'alias') ports['executor'] = ports['database'];
    if (fault === 'dependency')
      ports['executor'] = { dependency: 'database', sample: vi.fn(), close: vi.fn() };
    if (fault === 'sample')
      ports['executor'] = { dependency: 'executor', sample: 'HEALTHY', close: vi.fn() };
    if (fault === 'close') ports['executor'] = { dependency: 'executor', sample: vi.fn() };
    await expect(
      runtime.createPostgresPaperRuntimeCollector({
        database,
        probes: ports,
      } as unknown as PaperRuntimeCollectorOptions),
    ).rejects.toThrow('PAPER_RUNTIME_COLLECTOR_INPUT');
  },
);

it.each(['now', 'store', 'observer', 'health', 'tenantId', 'capabilities'])(
  'rejects caller %s override',
  async (field) => {
    const options = { database, probes: probes(), [field]: 'untrusted' };
    await expect(runtime.createPostgresPaperRuntimeCollector(options)).rejects.toThrow(
      'PAPER_RUNTIME_COLLECTOR_INPUT',
    );
  },
);

it.each([
  { connectionString: 'https://example.invalid', environment: 'test' },
  { connectionString: 'postgresql://user:pass@remote.invalid/db', environment: 'test' },
  {
    connectionString: 'postgresql://user:pass@127.0.0.1/db?sslmode=disable',
    environment: 'production',
  },
])('keeps the existing server-controlled URL/TLS boundary %#', async (options) => {
  const ports = probes();
  const sample = vi.fn(ports.executor.sample);
  const monitored = { ...ports, executor: { ...ports.executor, sample } };
  await expect(
    runtime.createPostgresPaperRuntimeCollector({
      database: options,
      probes: monitored,
    } as PaperRuntimeCollectorOptions),
  ).rejects.toThrow('PAPER_RUNTIME_DATABASE_URL');
  expect(sample).not.toHaveBeenCalled();
});

it('unknown negative-probe dependency is rejected without echoing input', () => {
  expect(() =>
    runtime.createUnavailablePaperRuntimeProbe('private-secret-value' as 'executor'),
  ).toThrow('PAPER_RUNTIME_COLLECTOR_INPUT');
});
