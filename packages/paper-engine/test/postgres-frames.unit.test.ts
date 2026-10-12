import { beforeEach, expect, it, vi } from 'vitest';
import * as candidate from '../src/postgres-frames.js';
import { frameFixture } from './frame-fixture.js';
import type { PaperMarketFrames } from '../src/frame-domain.js';
const state = vi.hoisted(
  (): {
    failed: string;
    configuration: unknown;
    snapshots: unknown;
    trades: unknown;
    calls: string[];
    urls: string[];
  } => ({
    failed: '',
    configuration: null,
    snapshots: null,
    trades: null,
    calls: [],
    urls: [],
  }),
);
vi.mock('../src/postgres-configuration.js', () => ({
  createPostgresPaperConfiguration: async (o: { connectionString: string }) => {
    await Promise.resolve();
    state.calls.push('configuration');
    state.urls.push(o.connectionString);
    if (state.failed === 'configuration') throw new Error('secret DSN');
    return state.configuration;
  },
}));
vi.mock('@ctp/market-data', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@ctp/market-data');
  return {
    ...actual,
    createPostgresMarketSnapshots: async (o: { connectionString: string }) => {
      await Promise.resolve();
      state.calls.push('snapshots');
      state.urls.push(o.connectionString);
      if (state.failed === 'snapshots') throw new Error('secret SQL');
      return state.snapshots;
    },
    createPostgresMarketTrades: async (o: { connectionString: string }) => {
      await Promise.resolve();
      state.calls.push('trades');
      state.urls.push(o.connectionString);
      if (state.failed === 'trades') throw new Error('secret URL');
      return state.trades;
    },
  };
});
type Options = {
  configurationUrl: string;
  snapshotUrl: string;
  tradeUrl: string;
  environment: 'test' | 'development' | 'staging' | 'production';
  [key: string]: unknown;
};
const options = (): Options => ({
  configurationUrl: 'postgresql://config:pass@127.0.0.1:5432/ctp',
  snapshotUrl: 'postgresql://snapshot:pass@127.0.0.1:5432/ctp',
  tradeUrl: 'postgresql://trade:pass@127.0.0.1:5432/ctp',
  environment: 'test',
});
const open = (o: Options): Promise<PaperMarketFrames> => {
  const factory = candidate.createPostgresPaperMarketFrames;
  if (!factory) return Promise.reject(new Error('PAPER_FRAME_FACTORY_MISSING'));
  return factory(o);
};
beforeEach(() => {
  state.failed = '';
  state.calls = [];
  state.urls = [];
});
for (const field of ['configurationUrl', 'snapshotUrl', 'tradeUrl'] as const) {
  it('rejects invalid ' + field + ' before opening any port', async () => {
    await expect(open({ ...options(), [field]: 'https://attacker.invalid' })).rejects.toThrow(
      'PAPER_FRAME_DATABASE_URL',
    );
    expect(state.calls).toEqual([]);
  });
  it('requires staging verify-full TLS for ' + field, async () => {
    const o = options();
    for (const key of ['configurationUrl', 'snapshotUrl', 'tradeUrl'] as const)
      o[key] += '?sslmode=verify-full';
    o[field] = o[field].split('?')[0]!;
    o.environment = 'staging';
    await expect(open(o)).rejects.toThrow('PAPER_FRAME_DATABASE_URL');
    expect(state.calls).toEqual([]);
  });
}
it('rejects different physical database and mixed authority roles before I/O', async () => {
  await expect(
    open({ ...options(), tradeUrl: 'postgresql://trade:pass@127.0.0.1:5432/other' }),
  ).rejects.toThrow('PAPER_FRAME_DATABASE_URL');
  await expect(open({ ...options(), tradeUrl: options().snapshotUrl })).rejects.toThrow(
    'PAPER_FRAME_DATABASE_URL',
  );
  expect(state.calls).toEqual([]);
});
it('rejects caller URLs, credentials, raw ports and clock overrides in options', async () => {
  for (const extra of [
    { tenantId: 'raw' },
    { credentials: {} },
    { ports: {} },
    { now: Date.now },
    { endpointUrl: 'https://attacker.invalid' },
  ])
    await expect(open({ ...options(), ...extra })).rejects.toThrow('PAPER_FRAME_DATABASE_URL');
  expect(state.calls).toEqual([]);
});
for (const failed of ['snapshots', 'trades'])
  it('closes every earlier owned port on ' + failed + ' startup rejection', async () => {
    const f = frameFixture();
    state.configuration = f.ports.configuration;
    state.snapshots = f.ports.snapshots;
    state.trades = f.ports.trades;
    state.failed = failed;
    await expect(open(options())).rejects.toThrow('PAPER_FRAME_STARTUP');
    expect(f.ports.configuration.close).toHaveBeenCalledTimes(1);
    expect(f.ports.snapshots.close).toHaveBeenCalledTimes(failed === 'trades' ? 1 : 0);
  });
it('public factory creates fixed PostgreSQL ports and returns no injected or mutation methods', async () => {
  const f = frameFixture();
  state.configuration = f.ports.configuration;
  state.snapshots = f.ports.snapshots;
  state.trades = f.ports.trades;
  const h = await open(options());
  expect(state.calls).toEqual(['configuration', 'snapshots', 'trades']);
  expect(Object.keys(h).sort()).toEqual(['capture', 'close']);
  await h.close();
});
it('captures validated deployment options before any asynchronous startup', async () => {
  const f = frameFixture();
  state.configuration = f.ports.configuration;
  state.snapshots = f.ports.snapshots;
  state.trades = f.ports.trades;
  const o = options(),
    original = { ...o },
    pending = open(o);
  o.snapshotUrl = 'postgresql://other:pass@127.0.0.1:5432/other';
  o.tradeUrl = o.snapshotUrl;
  const h = await pending;
  expect(state.urls).toEqual([original.configurationUrl, original.snapshotUrl, original.tradeUrl]);
  await h.close();
});
