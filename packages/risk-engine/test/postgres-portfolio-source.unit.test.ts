/* eslint-disable @typescript-eslint/require-await -- Deterministic wire fixtures have no network. */
import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { canonical, createState, reducePortfolio } from '@ctp/portfolio';
import { binding, snapshot } from '../../portfolio/test/fixtures.js';
type WireState = {
  safe: boolean;
  raw: unknown;
  queries: string[];
  commits: number;
  failCommit: boolean;
  ended: number;
  releases: number;
  destroy: number;
  hang: boolean;
  reject: (() => void) | null;
  afterCommit: (() => void) | null;
};
const wire = vi.hoisted((): WireState => ({
  safe: true,
  raw: null,
  queries: [] as string[],
  commits: 0,
  failCommit: false,
  ended: 0,
  releases: 0,
  destroy: 0,
  hang: false,
  reject: null as (() => void) | null,
  afterCommit: null as (() => void) | null,
}));
vi.mock('pg', () => {
  class Pool {
    on() {
      return this;
    }
    async end() {
      wire.ended++;
    }
    async connect() {
      let released = false;
      return {
        once() {},
        async query(sql: string) {
          wire.queries.push(sql);
          if (sql.includes('AS safe')) return { rows: [{ safe: wire.safe }] };
          if (sql.includes('capture_portfolio')) {
            if (wire.hang)
              await new Promise<void>((_, reject) => {
                wire.reject = () => reject(new Error('wire disconnected credential=must-not-leak'));
              });
            return { rows: [{ result: wire.raw }] };
          }
          if (sql === 'COMMIT') {
            wire.commits++;
            if (wire.failCommit) throw new Error('uncertain wire commit credential=must-not-leak');
            wire.afterCommit?.();
          }
          return { rows: [] };
        },
        release(destroy = false) {
          if (released) throw new Error('double release');
          released = true;
          wire.releases++;
          if (destroy) {
            wire.destroy++;
            wire.reject?.();
          }
        },
      };
    }
  }
  return { Pool };
});
import { createPostgresRiskPortfolioReader } from '../src/postgres-portfolio-source.js';
const options = {
  connectionString: 'postgresql://reader:private@127.0.0.1/isolated',
  environment: 'test' as const,
};
const io = (signal = new AbortController().signal, ms = 2500) => ({
  signal,
  deadline: Date.now() + ms,
});
function fixture() {
  const b = binding(),
    now = Date.now(),
    state = reducePortfolio(createState(b), snapshot({ timestamp: now }), { now: () => now }).state,
    stateText = canonical(state);
  wire.raw = {
    scope: { tenantId: b.tenantId, mode: b.mode },
    accounts: [
      {
        id: b.accountId,
        exchange: b.scope.exchange,
        region: b.scope.region,
        externalAccountId: b.externalAccountId,
        accountMode: 'SPOT',
        status: 'DISABLED',
        permissionEpoch: '1',
        reconciliationEpoch: '1',
        version: 1,
      },
    ],
    books: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        accountId: b.accountId,
        wallet: b.walletId,
        revision: '1',
        stateText,
        hash: createHash('sha256').update(stateText).digest('hex'),
        holdWatermarks: [],
      },
    ],
  };
  return {
    tenantId: b.tenantId,
    mode: b.mode,
    targetAccountId: b.accountId,
    maxEvidenceAgeMs: 5000,
  };
}
beforeEach(() => {
  Object.assign(wire, {
    safe: true,
    raw: null,
    queries: [],
    commits: 0,
    failCommit: false,
    ended: 0,
    releases: 0,
    destroy: 0,
    hang: false,
    reject: null,
    afterCommit: null,
  });
});
it('uses bounded READ COMMITTED, tenant context, SQL authority and a known COMMIT before publishing source', async () => {
  const reader = await createPostgresRiskPortfolioReader(options),
    scope = fixture();
  const source = await reader.read(scope, io());
  expect(source.scope.tenantId).toBe(scope.tenantId);
  expect(wire.queries.filter((q) => q === 'BEGIN ISOLATION LEVEL READ COMMITTED')).toHaveLength(2);
  expect(wire.queries).toContain("SELECT set_config('app.tenant_id',$1,true)");
  expect(wire.commits).toBe(2);
  await reader.close();
  await reader.close();
  expect(wire.ended).toBe(1);
});
it('never publishes a source after uncertain COMMIT and redacts underlying SQL/private data', async () => {
  const reader = await createPostgresRiskPortfolioReader(options),
    scope = fixture();
  wire.failCommit = true;
  await expect(reader.read(scope, io())).rejects.toThrow('RISK_PORTFOLIO_STORE_FAILED');
  expect(wire.queries.at(-1)).toBe('ROLLBACK');
  await reader.close();
});
it('rejects unsafe startup role and closes the pool', async () => {
  wire.safe = false;
  await expect(createPostgresRiskPortfolioReader(options)).rejects.toThrow(
    'RISK_PORTFOLIO_ROLE_UNSAFE',
  );
  expect(wire.ended).toBe(1);
  expect(wire.commits).toBe(0);
});
it.each(['abort', 'deadline'] as const)(
  'physically destroys a hung transport on %s without COMMIT',
  async (kind) => {
    const reader = await createPostgresRiskPortfolioReader(options),
      scope = fixture(),
      controller = new AbortController();
    wire.hang = true;
    const timer = kind === 'abort' ? setTimeout(() => controller.abort(), 20) : undefined;
    try {
      await expect(
        reader.read(scope, io(controller.signal, kind === 'deadline' ? 20 : 1000)),
      ).rejects.toThrow('RISK_PORTFOLIO_ABORTED');
    } finally {
      clearTimeout(timer);
      await reader.close();
    }
    expect(wire.destroy).toBe(1);
    expect(wire.commits).toBe(1);
  },
);
it('does no source I/O for pre-aborted input and rejects calls after close', async () => {
  const reader = await createPostgresRiskPortfolioReader(options),
    scope = fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(reader.read(scope, io(controller.signal))).rejects.toThrow('RISK_PORTFOLIO_ABORTED');
  expect(wire.queries.some((q) => q.startsWith('SELECT ctp_risk.capture_portfolio'))).toBe(false);
  await reader.close();
  await expect(reader.read(scope, io())).rejects.toThrow('RISK_PORTFOLIO_CLOSED');
});
it('does not publish originally fresh evidence that expires while COMMIT completes', async () => {
  let now = 1000000000000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const reader = await createPostgresRiskPortfolioReader(options),
    scope = { ...fixture(), maxEvidenceAgeMs: 10 };
  wire.afterCommit = () => {
    now += 20;
  };
  try {
    await expect(reader.read(scope, io())).rejects.toThrow('RISK_PORTFOLIO_INCOMPLETE');
  } finally {
    clock.mockRestore();
    await reader.close();
  }
});
it.each([
  { ...options, connectionString: 'https://user:private@example.invalid' },
  { ...options, environment: 'production' as const },
  { ...options, connectionString: 'postgresql://reader:private@arbitrary.example/isolated' },
  { ...options, snapshot: { complete: true } },
])('rejects non-server database configuration or injected snapshot', async (invalid) => {
  await expect(createPostgresRiskPortfolioReader(invalid)).rejects.toThrow(
    'RISK_PORTFOLIO_DATABASE_URL',
  );
  expect(wire.queries).toHaveLength(0);
});
