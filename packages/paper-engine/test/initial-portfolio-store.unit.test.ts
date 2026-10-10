import { beforeEach, expect, it, vi } from 'vitest';
import { createPostgresPaperInitialPortfolio } from '../src/postgres-initial-portfolio.js';
import { initialPortfolioWire } from './initial-portfolio-fixtures.js';
const wire = vi.hoisted(() => ({
  safe: true,
  commitFailure: false,
  badHash: false,
  fail: '',
  abortAtCommit: null as AbortController | null,
  calls: [] as string[],
}));
vi.mock('pg', () => ({
  Client: class {
    on() {}
    async connect() {}
    async end() {}
    async query(sql: string) {
      await Promise.resolve();
      wire.calls.push(sql);
      if (sql.includes(' AS safe')) return { rows: [{ safe: wire.safe }] };
      if (sql === 'COMMIT') {
        wire.abortAtCommit?.abort();
        if (wire.commitFailure) throw new Error('connection-secret-loss');
      }
      if (sql.includes('capture_initial_portfolio(')) {
        if (wire.fail) throw new Error(wire.fail);
        const f = initialPortfolioWire(Date.now());
        if (wire.badHash) f.wire.funding.hash = 'a'.repeat(64);
        return { rows: [{ result: f.wire }] };
      }
      return { rows: [] };
    }
  },
}));
const options = {
  connectionString: 'postgresql://paper:fixture@127.0.0.1/test',
  environment: 'test' as const,
};
const io = (signal = new AbortController().signal) => ({ signal, deadline: Date.now() + 2500 });
beforeEach(() => {
  wire.safe = true;
  wire.commitFailure = false;
  wire.badHash = false;
  wire.fail = '';
  wire.abortAtCommit = null;
  wire.calls = [];
});
it('acknowledges read-only capture before immutable common Portfolio publication', async () => {
  const store = await createPostgresPaperInitialPortfolio(options);
  wire.calls = [];
  try {
    const s = await store.read(initialPortfolioWire().owner, io());
    expect(s.state.binding.connectionId).toBeNull();
    expect(Object.isFrozen(s.state.balances)).toBe(true);
    expect(wire.calls.at(-1)).toBe('COMMIT');
    expect(
      wire.calls.filter((c) =>
        /^(INSERT|UPDATE|DELETE)|initialize_funding|register_configuration/u.test(c),
      ),
    ).toEqual([]);
    expect(Object.keys(store).sort()).toEqual(['close', 'read']);
  } finally {
    await store.close();
  }
});
it('uncertain read COMMIT publishes no source and performs no retry', async () => {
  const store = await createPostgresPaperInitialPortfolio(options);
  wire.calls = [];
  wire.commitFailure = true;
  try {
    await expect(store.read(initialPortfolioWire().owner, io())).rejects.toThrow(
      'PAPER_PORTFOLIO_UNCERTAIN',
    );
    expect(wire.calls.filter((c) => c.includes('capture_initial_portfolio('))).toHaveLength(1);
  } finally {
    await store.close();
  }
});
it('abort at read COMMIT publishes no source', async () => {
  const store = await createPostgresPaperInitialPortfolio(options),
    c = new AbortController();
  wire.abortAtCommit = c;
  try {
    await expect(store.read(initialPortfolioWire().owner, io(c.signal))).rejects.toThrow(
      'PAPER_PORTFOLIO_UNCERTAIN',
    );
  } finally {
    await store.close();
  }
});
it('corrupt provenance and owner conflict reject before COMMIT', async () => {
  const store = await createPostgresPaperInitialPortfolio(options);
  try {
    wire.calls = [];
    wire.badHash = true;
    await expect(store.read(initialPortfolioWire().owner, io())).rejects.toThrow(
      'PAPER_PORTFOLIO_CORRUPT',
    );
    expect(wire.calls).not.toContain('COMMIT');
    wire.badHash = false;
    await expect(
      store.read(
        { ...initialPortfolioWire().owner, accountId: '55555555-5555-4555-8555-555555555555' },
        io(),
      ),
    ).rejects.toThrow('PAPER_PORTFOLIO_CORRUPT');
  } finally {
    await store.close();
  }
});
it.each([
  'PAPER_PORTFOLIO_INCOMPLETE',
  'PAPER_PORTFOLIO_MISSING',
  'PAPER_PORTFOLIO_OWNERSHIP',
  'private SQL secret',
])('sanitizes or preserves known SQL failure %s', async (code) => {
  const store = await createPostgresPaperInitialPortfolio(options);
  wire.fail = code;
  try {
    await expect(store.read(initialPortfolioWire().owner, io())).rejects.toThrow(
      code.startsWith('PAPER_') ? code : 'PAPER_PORTFOLIO_STORE_FAILED',
    );
  } finally {
    await store.close();
  }
});
it('startup refuses unsafe role authority', async () => {
  wire.safe = false;
  await expect(createPostgresPaperInitialPortfolio(options)).rejects.toThrow(
    'PAPER_PORTFOLIO_ROLE_UNSAFE',
  );
});
it('preabort, expired, malformed and closed IO never acquires a read slot', async () => {
  const store = await createPostgresPaperInitialPortfolio(options),
    c = new AbortController();
  c.abort();
  wire.calls = [];
  try {
    await expect(store.read(initialPortfolioWire().owner, io(c.signal))).rejects.toThrow(
      'PAPER_PORTFOLIO_ABORTED',
    );
    await expect(
      store.read(initialPortfolioWire().owner, {
        signal: new AbortController().signal,
        deadline: 0,
      }),
    ).rejects.toThrow('PAPER_PORTFOLIO_ABORTED');
    await expect(store.read(initialPortfolioWire().owner, null as never)).rejects.toThrow(
      'PAPER_PORTFOLIO_INPUT',
    );
    expect(wire.calls).toEqual([]);
  } finally {
    await store.close();
  }
  await expect(store.read(initialPortfolioWire().owner, io())).rejects.toThrow(
    'PAPER_PORTFOLIO_CLOSED',
  );
});
it.each([
  'https://example.invalid',
  'postgres://paper@127.0.0.1/test',
  'postgres://p:f@127.0.0.1/test?sslmode=verify-full&sslmode=disable',
  'postgres://p:f@127.0.0.1/test?options=unsafe',
])('rejects database URL %s without IO', async (connectionString) => {
  await expect(
    createPostgresPaperInitialPortfolio({ ...options, connectionString }),
  ).rejects.toThrow('PAPER_PORTFOLIO_DATABASE_URL');
  expect(wire.calls).toEqual([]);
});
it('production requires verify-full TLS', async () => {
  await expect(
    createPostgresPaperInitialPortfolio({ ...options, environment: 'production' }),
  ).rejects.toThrow('PAPER_PORTFOLIO_DATABASE_URL');
});
