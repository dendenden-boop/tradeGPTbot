import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import { beforeEach, expect, it, vi } from 'vitest';
import { createPostgresMarketTrades } from '../src/postgres-trades.js';
import { tradeFixture } from './trade-fixture.js';

const wire = vi.hoisted(() => ({
  safe: true,
  failedCommit: false,
  abortCommit: null as AbortController | null,
  text: '',
  badHash: false,
  badId: false,
  failedSql: false,
  calls: [] as string[],
}));
vi.mock('pg', () => ({
  Client: class {
    socket: Socket;
    constructor(options: { stream(): Socket }) {
      this.socket = options.stream();
    }
    on() {
      return this;
    }
    async connect() {}
    async end() {
      this.socket.destroy();
      await Promise.resolve();
    }
    async query(sql: string, args?: unknown[]) {
      await Promise.resolve();
      wire.calls.push(sql);
      if (sql === 'COMMIT') {
        wire.abortCommit?.abort();
        if (wire.failedCommit) throw new Error('secret connection details');
      }
      if (sql.includes(' AS safe ')) return { rows: [{ safe: wire.safe }] };
      if (sql.includes('ctp_market.') && wire.failedSql) throw new Error('secret native payload');
      if (sql.includes('publish_trade')) {
        const p = JSON.parse(args?.[0] as string) as { id: string };
        return {
          rows: [
            {
              result: {
                id: wire.badId ? '11111111-1111-4111-8111-111111111111' : p.id,
                revision: '1',
                status: 'APPLIED',
              },
            },
          ],
        };
      }
      if (sql.includes('trade_head_state'))
        return { rows: [{ result: { revision: '1', gap: false } }] };
      if (sql.includes('read_trade')) {
        const p = JSON.parse(wire.text) as { id: string };
        return {
          rows: [
            {
              result: {
                id: wire.badId ? '11111111-1111-4111-8111-111111111111' : p.id,
                revision: '1',
                text: wire.text,
                hash: wire.badHash
                  ? 'a'.repeat(64)
                  : createHash('sha256').update(wire.text).digest('hex'),
              },
            },
          ],
        };
      }
      return { rows: [] };
    }
  },
}));
const options = {
  connectionString: 'postgresql://trade:unused@127.0.0.1/trade_test',
  environment: 'test' as const,
};
const io = (signal = new AbortController().signal) => ({ signal, deadline: Date.now() + 2500 });
beforeEach(() => {
  wire.safe = true;
  wire.failedCommit = false;
  wire.abortCommit = null;
  wire.text = '';
  wire.badHash = false;
  wire.badId = false;
  wire.failedSql = false;
  wire.calls = [];
});

it('has only public journal operations and bounded READ COMMITTED before known COMMIT', async () => {
  const s = await createPostgresMarketTrades(options);
  try {
    expect(Object.keys(s).sort()).toEqual(['close', 'head', 'publish', 'read']);
    expect((await s.publish(tradeFixture(), io())).status).toBe('APPLIED');
    expect(wire.calls.filter((v) => v.startsWith('BEGIN'))).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'BEGIN ISOLATION LEVEL READ COMMITTED',
    ]);
    expect(wire.calls.at(-1)).toBe('COMMIT');
  } finally {
    await s.close();
  }
});
it('uncertain publication COMMIT returns no receipt and performs no blind retry', async () => {
  const s = await createPostgresMarketTrades(options);
  wire.failedCommit = true;
  try {
    await expect(s.publish(tradeFixture(), io())).rejects.toThrow('MARKET_TRADE_UNCERTAIN');
    expect(
      wire.calls.filter((v) => v.includes('publish_trade') && v.startsWith('SELECT ctp_market')),
    ).toHaveLength(1);
  } finally {
    await s.close();
  }
});
it('abort during acknowledged COMMIT still returns no receipt', async () => {
  const s = await createPostgresMarketTrades(options),
    controller = new AbortController();
  wire.abortCommit = controller;
  try {
    await expect(s.publish(tradeFixture(), io(controller.signal))).rejects.toThrow(
      'MARKET_TRADE_UNCERTAIN',
    );
  } finally {
    await s.close();
  }
});
it('reads original native bytes and immutable source without granting financial authority', async () => {
  const p = tradeFixture(),
    s = await createPostgresMarketTrades(options);
  wire.text = JSON.stringify(p);
  try {
    const r = await s.read(p.key, io());
    expect(r.publication).toEqual(p);
    expect(Object.isFrozen(r.publication.trade)).toBe(true);
    expect('grant' in r).toBe(false);
    expect(await s.head(p.key, io())).toEqual({ revision: '1', gap: false });
  } finally {
    await s.close();
  }
});
it.each(['hash', 'id', 'scope'] as const)('rejects corrupt source %s', async (kind) => {
  const p = tradeFixture(),
    s = await createPostgresMarketTrades(options);
  wire.text = JSON.stringify(
    kind === 'scope'
      ? { ...p, key: { ...p.key, dbInstrumentId: '11111111-1111-4111-8111-111111111111' } }
      : p,
  );
  wire.badHash = kind === 'hash';
  wire.badId = kind === 'id';
  try {
    await expect(s.read(p.key, io())).rejects.toThrow('MARKET_TRADE_CORRUPT');
  } finally {
    await s.close();
  }
});
it('refuses mismatched publication receipt identity', async () => {
  const s = await createPostgresMarketTrades(options);
  wire.badId = true;
  try {
    await expect(s.publish(tradeFixture(), io())).rejects.toThrow('MARKET_TRADE_CORRUPT');
  } finally {
    await s.close();
  }
});
it.each([0, 5001, 1.5, NaN])('invalid maximum source age %s fails before query', async (age) => {
  const s = await createPostgresMarketTrades(options);
  wire.calls = [];
  try {
    await expect(s.read(tradeFixture().key, io(), age)).rejects.toThrow('MARKET_TRADE_INPUT');
    expect(wire.calls).toEqual([]);
  } finally {
    await s.close();
  }
});
it('caller authority fields fail before SQL', async () => {
  const s = await createPostgresMarketTrades(options);
  wire.calls = [];
  try {
    await expect(
      s.publish({ ...tradeFixture(), tenantId: 'untrusted' } as never, io()),
    ).rejects.toThrow('MARKET_TRADE_INPUT');
    expect(wire.calls).toEqual([]);
  } finally {
    await s.close();
  }
});
it('already aborted publication never connects or starts SQL', async () => {
  const s = await createPostgresMarketTrades(options),
    controller = new AbortController();
  controller.abort();
  wire.calls = [];
  try {
    await expect(s.publish(tradeFixture(), io(controller.signal))).rejects.toThrow(
      'MARKET_TRADE_ABORTED',
    );
    expect(wire.calls).toEqual([]);
  } finally {
    await s.close();
  }
});
it('close permanently stops journal operations', async () => {
  const s = await createPostgresMarketTrades(options);
  await s.close();
  wire.calls = [];
  await expect(s.head(tradeFixture().key, io())).rejects.toThrow('MARKET_TRADE_CLOSED');
  expect(wire.calls).toEqual([]);
});
it('SQL failures do not expose native payloads or connection material', async () => {
  const s = await createPostgresMarketTrades(options);
  wire.failedSql = true;
  try {
    const error = await s.publish(tradeFixture(), io()).catch((e) => e as Error);
    if (!(error instanceof Error)) throw new Error('EXPECTED_STORE_FAILURE');
    expect(error.message).toBe('MARKET_TRADE_STORE_FAILED');
    expect((error.cause as Error).message).toBe('MARKET_TRADE_TRANSACTION_FAILED');
  } finally {
    await s.close();
  }
});
it('rejects unsafe role graph before exposing a store', async () => {
  wire.safe = false;
  await expect(createPostgresMarketTrades(options)).rejects.toThrow('MARKET_TRADE_ROLE_UNSAFE');
});
it.each(['tenantId', 'url', 'credentials'])('rejects factory override %s', async (field) => {
  await expect(createPostgresMarketTrades({ ...options, [field]: 'untrusted' })).rejects.toThrow(
    'MARKET_TRADE_DATABASE_URL',
  );
});
