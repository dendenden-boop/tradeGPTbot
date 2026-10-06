import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { createPostgresLossJournal } from '../src/postgres-loss-journal.js';
import { lossBatchSchema } from '../src/loss-journal.js';
const wire = vi.hoisted(() => ({
  safe: true,
  commitFailure: false,
  abortAtCommit: null as AbortController | null,
  corrupt: false,
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
        release: (destroy?: boolean) => {
          wire.released.push(destroy === true);
        },
        query: (sql: string, args?: unknown[]) => {
          wire.calls.push(sql);
          if (sql === 'COMMIT') {
            wire.abortAtCommit?.abort();
            if (wire.commitFailure) return Promise.reject(new Error('wire lost after commit'));
          }
          if (sql.includes(' AS safe ')) return Promise.resolve({ rows: [{ safe: wire.safe }] });
          if (sql.includes('append_loss_batch')) {
            const p = lossBatchSchema.parse(JSON.parse(args?.[0] as string));
            const checkpointText = JSON.stringify({
              scope: p.scope,
              dayStart: p.dayStart,
              sequence: '2',
              batchId: p.id,
              coveredThrough: p.coveredThrough,
              openingEquity: '1000',
              externalFlows: '0',
              netRealized: '0',
              adjustedCurrentEquity: '1000',
              adjustedPeakEquity: '1000',
            });
            return Promise.resolve({
              rows: [
                {
                  result: {
                    checkpointText,
                    hash: wire.corrupt
                      ? 'a'.repeat(64)
                      : createHash('sha256').update(checkpointText).digest('hex'),
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
  connectionString: 'postgresql://collector:unused@127.0.0.1/loss_test',
  environment: 'test' as const,
};
const io = (signal = new AbortController().signal) => ({ signal, deadline: Date.now() + 2500 });
const batch = () => {
  const now = Date.now(),
    day = Math.floor(now / 86400000) * 86400000;
  return lossBatchSchema.parse({
    scope: { tenantId: randomUUID(), mode: 'TESTNET', valuationAsset: 'USDT' },
    dayStart: day,
    id: randomUUID(),
    expectedSequence: '0',
    opening: { at: day, equity: '1000', sourceId: randomUUID(), sourceHash: 'a'.repeat(64) },
    coveredThrough: now,
    events: [{ id: randomUUID(), at: now, kind: 'EQUITY', amount: '1000' }],
    coverage: { from: day, through: now, sourceId: randomUUID(), sourceHash: 'b'.repeat(64) },
  });
};
beforeEach(() => {
  wire.safe = true;
  wire.commitFailure = false;
  wire.abortAtCommit = null;
  wire.corrupt = false;
  wire.calls = [];
  wire.released = [];
});
it('loss collector uses explicit READ COMMITTED and known COMMIT before returning a checkpoint', async () => {
  const journal = await createPostgresLossJournal(options);
  try {
    expect((await journal.append(batch(), io())).sequence).toBe('2');
    expect(wire.calls.filter((s) => s.startsWith('BEGIN'))).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'BEGIN ISOLATION LEVEL READ COMMITTED',
    ]);
    expect(wire.calls.at(-1)).toBe('COMMIT');
  } finally {
    await journal.close();
  }
});
it('uncertain COMMIT returns no successful durable checkpoint', async () => {
  const journal = await createPostgresLossJournal(options);
  wire.commitFailure = true;
  try {
    await expect(journal.append(batch(), io())).rejects.toThrow('RISK_LOSS_JOURNAL_STORE_FAILED');
    expect(wire.calls).toContain('ROLLBACK');
  } finally {
    await journal.close();
  }
});
it('abort as COMMIT settles destroys the connection and returns no successful result', async () => {
  const journal = await createPostgresLossJournal(options),
    abort = new AbortController();
  wire.abortAtCommit = abort;
  try {
    await expect(journal.append(batch(), io(abort.signal))).rejects.toThrow(
      'RISK_LOSS_JOURNAL_ABORTED',
    );
    expect(wire.released.at(-1)).toBe(true);
  } finally {
    await journal.close();
  }
});
it('corrupt checkpoint content is rejected before COMMIT', async () => {
  const journal = await createPostgresLossJournal(options);
  wire.corrupt = true;
  try {
    await expect(journal.append(batch(), io())).rejects.toThrow('RISK_LOSS_JOURNAL_CORRUPT');
    expect(wire.calls.at(-1)).toBe('ROLLBACK');
  } finally {
    await journal.close();
  }
});
it('unsafe SQL authority cannot start the collector or publish evidence', async () => {
  wire.safe = false;
  await expect(createPostgresLossJournal(options)).rejects.toThrow('RISK_LOSS_JOURNAL_ROLE_UNSAFE');
  expect(wire.calls.some((s) => s.includes('append_loss_batch($1'))).toBe(false);
});
it('expired deadline, pre-abort and closed store never publish evidence', async () => {
  const journal = await createPostgresLossJournal(options),
    abort = new AbortController();
  abort.abort();
  await expect(journal.append(batch(), io(abort.signal))).rejects.toThrow(
    'RISK_LOSS_JOURNAL_ABORTED',
  );
  await expect(journal.append(batch(), { ...io(), deadline: 0 })).rejects.toThrow(
    'RISK_LOSS_JOURNAL_ABORTED',
  );
  await journal.close();
  await expect(journal.append(batch(), io())).rejects.toThrow('RISK_LOSS_JOURNAL_CLOSED');
  expect(wire.calls.some((s) => s.includes('append_loss_batch($1'))).toBe(false);
});
