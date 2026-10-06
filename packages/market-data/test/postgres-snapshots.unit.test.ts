import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { createPostgresMarketSnapshots } from '../src/postgres-snapshots.js';
import { snapshotFixture } from './snapshot-fixture.js';
const wire = vi.hoisted(() => ({
  safe: true,
  failedCommit: false,
  abortCommit: null as AbortController | null,
  text: '',
  badHash: false,
  badId: false,
  calls: [] as string[],
  released: [] as boolean[],
}));
vi.mock('pg', () => ({
  Pool: class {
    on() {
      return this;
    }
    async end() {}
    connect() {
      return Promise.resolve({
        once() {},
        release(destroy = false) {
          wire.released.push(destroy);
        },
        query(sql: string, args?: unknown[]) {
          wire.calls.push(sql);
          if (sql === 'COMMIT') {
            wire.abortCommit?.abort();
            if (wire.failedCommit) return Promise.reject(new Error('secret connection details'));
          }
          if (sql.includes(' AS safe ')) return Promise.resolve({ rows: [{ safe: wire.safe }] });
          if (sql.includes('publish_snapshot')) {
            const p = JSON.parse(args?.[0] as string) as { id: string };
            return Promise.resolve({
              rows: [
                {
                  result: {
                    id: wire.badId ? '11111111-1111-4111-8111-111111111111' : p.id,
                    revision: '1',
                    status: 'APPLIED',
                  },
                },
              ],
            });
          }
          if (sql.includes('read_snapshot')) {
            const p = JSON.parse(wire.text) as { id: string };
            return Promise.resolve({
              rows: [
                {
                  result: {
                    id: p.id,
                    revision: '1',
                    text: wire.text,
                    hash: wire.badHash
                      ? 'a'.repeat(64)
                      : createHash('sha256').update(wire.text).digest('hex'),
                  },
                },
              ],
            });
          }
          return Promise.resolve({ rows: [] });
        },
      });
    }
  },
}));
const options = {
  connectionString: 'postgresql://snapshot:unused@127.0.0.1/snapshot_test',
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
  wire.calls = [];
  wire.released = [];
});
it('uses explicit bounded READ COMMITTED and returns only after known COMMIT', async () => {
  const store = await createPostgresMarketSnapshots(options);
  try {
    expect((await store.publish(snapshotFixture(), io())).revision).toBe('1');
    expect(wire.calls.filter((s) => s.startsWith('BEGIN'))).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'BEGIN ISOLATION LEVEL READ COMMITTED',
    ]);
    expect(wire.calls.at(-1)).toBe('COMMIT');
  } finally {
    await store.close();
  }
});
it('uncertain COMMIT produces no receipt and no blind retry', async () => {
  const store = await createPostgresMarketSnapshots(options);
  try {
    wire.failedCommit = true;
    await expect(store.publish(snapshotFixture(), io())).rejects.toThrow(
      'MARKET_EVIDENCE_STORE_FAILED',
    );
    expect(
      wire.calls.filter((s) => s.startsWith('SELECT ctp_market.publish_snapshot(')),
    ).toHaveLength(1);
  } finally {
    await store.close();
  }
});
it('abort during COMMIT produces no authoritative result and destroys connection', async () => {
  const store = await createPostgresMarketSnapshots(options),
    abort = new AbortController();
  try {
    wire.abortCommit = abort;
    await expect(store.publish(snapshotFixture(), io(abort.signal))).rejects.toThrow(
      'MARKET_EVIDENCE_ABORTED',
    );
    expect(wire.released.at(-1)).toBe(true);
  } finally {
    await store.close();
  }
});
it('pre-abort, expired deadline and closed factory never publish', async () => {
  const store = await createPostgresMarketSnapshots(options),
    abort = new AbortController();
  abort.abort();
  await expect(store.publish(snapshotFixture(), io(abort.signal))).rejects.toThrow(
    'MARKET_EVIDENCE_ABORTED',
  );
  await expect(store.publish(snapshotFixture(), { ...io(), deadline: 0 })).rejects.toThrow(
    'MARKET_EVIDENCE_ABORTED',
  );
  await store.close();
  await expect(store.publish(snapshotFixture(), io())).rejects.toThrow('MARKET_EVIDENCE_CLOSED');
  expect(wire.calls.some((s) => s.startsWith('SELECT ctp_market.publish_snapshot('))).toBe(false);
});
it('unsafe authority is rejected at startup', async () => {
  wire.safe = false;
  await expect(createPostgresMarketSnapshots(options)).rejects.toThrow(
    'MARKET_EVIDENCE_ROLE_UNSAFE',
  );
});
it('valid bounded native evidence reads with lossless source sequence', async () => {
  const store = await createPostgresMarketSnapshots(options),
    p = snapshotFixture();
  wire.text = JSON.stringify(p);
  try {
    expect((await store.read(p.key, io())).publication.book.sourceSequence).toBe(
      '9007199254740993',
    );
  } finally {
    await store.close();
  }
});
it.each(['hash', 'scope', 'future', 'stale', 'ruleExpired', 'id'])(
  'corrupt/stale database result fails closed: %s',
  async (kind) => {
    const store = await createPostgresMarketSnapshots(options),
      p = snapshotFixture();
    try {
      if (kind === 'hash') wire.badHash = true;
      if (kind === 'scope') p.key.dbInstrumentId = '11111111-1111-4111-8111-111111111111';
      if (kind === 'future') p.ticker.exchangeTime = Date.now() + 10000;
      if (kind === 'stale') p.book.receivedAt = Date.now() - 10000;
      if (kind === 'ruleExpired') p.record.rules.expiresAt = Date.now() - 1;
      if (kind === 'id') {
        wire.badId = true;
        await expect(store.publish(p, io())).rejects.toThrow('MARKET_EVIDENCE_CORRUPT');
        return;
      }
      wire.text = JSON.stringify(p);
      const key = {
        ...p.key,
        dbInstrumentId:
          kind === 'scope' ? '22222222-2222-4222-8222-222222222222' : p.key.dbInstrumentId,
      };
      await expect(store.read(key, io())).rejects.toThrow(/^MARKET_EVIDENCE_/);
    } finally {
      await store.close();
    }
  },
);
