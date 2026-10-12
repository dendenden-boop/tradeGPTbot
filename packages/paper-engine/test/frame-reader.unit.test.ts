import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { frameFixture } from './frame-fixture.js';
import { parseDecimal } from '@ctp/exchange-core';
import { setTimeout as wait } from 'node:timers/promises';

it('pairs exact durable evidence with immutable owned PAPER model and provenance', async () => {
  const f = frameFixture(),
    h = f.open(),
    r = await h.capture(f.request, f.io);
  expect(r.configuration).toEqual(f.configuration);
  expect(r.frame.model).toEqual(f.configuration.configuration.model);
  expect(r.frame.trade.tradeId).toBe(f.p.trade.tradeId);
  expect(r.evidence).toEqual({
    snapshotId: f.s.id,
    snapshotRevision: '1',
    snapshotHash: f.snapshot.hash,
    tradeId: f.p.id,
    tradeRevision: '1',
    tradeHash: f.trade.hash,
  });
  expect(r.capturedAt).toBe(f.now);
  expect(r.expiresAt).toBe(f.now + 2500);
  expect(Object.isFrozen(r.frame)).toBe(true);
  expect(Object.isFrozen(r.evidence)).toBe(true);
  expect(Object.keys(h).sort()).toEqual(['capture', 'close']);
  await h.close();
});
it('repeated capture preserves native volume identity without durable allocation or dispatch', async () => {
  const f = frameFixture(),
    h = f.open(),
    a = await h.capture(f.request, f.io),
    b = await h.capture(f.request, f.io);
  expect(a.evidence).toEqual(b.evidence);
  expect(a.frame.trade.tradeId).toBe(b.frame.trade.tradeId);
  expect(a.frame.volumeUsed).toBe('0');
  expect(b.frame.volumeUsed).toBe('0');
  expect('approve' in h).toBe(false);
  expect('reserve' in h).toBe(false);
  await h.close();
});
for (const [name, change] of [
  [
    'owner',
    (f: ReturnType<typeof frameFixture>) => {
      f.configuration.configuration.owner.accountId = randomUUID();
    },
  ],
  [
    'source',
    (f: ReturnType<typeof frameFixture>) => {
      f.configuration.configuration.source = {
        ...f.configuration.configuration.source,
        environment: f.p.key.scope.environment === 'TESTNET' ? 'LIVE' : 'TESTNET',
      };
    },
  ],
  [
    'book key',
    (f: ReturnType<typeof frameFixture>) => {
      f.snapshot.publication.key.dbRuleId = randomUUID();
    },
  ],
  [
    'trade key',
    (f: ReturnType<typeof frameFixture>) => {
      f.trade.publication.key.dbInstrumentId = randomUUID();
    },
  ],
  [
    'metadata disagreement',
    (f: ReturnType<typeof frameFixture>) => {
      f.snapshot.publication.record.instrument.metadataVersion = 'different';
    },
  ],
  [
    'rules disagreement',
    (f: ReturnType<typeof frameFixture>) => {
      f.snapshot.publication.record.rules.maxQuantity = parseDecimal('999');
    },
  ],
  [
    'snapshot ID',
    (f: ReturnType<typeof frameFixture>) => {
      f.snapshot.id = randomUUID();
    },
  ],
  [
    'trade ID',
    (f: ReturnType<typeof frameFixture>) => {
      f.trade.id = randomUUID();
    },
  ],
  [
    'future configuration',
    (f: ReturnType<typeof frameFixture>) => {
      f.configuration.createdAt = f.now + 1;
    },
  ],
  [
    'future trade',
    (f: ReturnType<typeof frameFixture>) => {
      f.trade.publication.trade.receivedAt = f.now + 1;
    },
  ],
  [
    'expired rules',
    (f: ReturnType<typeof frameFixture>) => {
      f.snapshot.publication.record.rules.expiresAt = f.now;
      f.trade.publication.record.rules.expiresAt = f.now;
    },
  ],
  [
    'future metadata',
    (f: ReturnType<typeof frameFixture>) => {
      f.snapshot.publication.record.rules.effectiveAt = f.now + 1;
      f.trade.publication.record.rules.effectiveAt = f.now + 1;
    },
  ],
] as const)
  it('fails closed on ' + name, async () => {
    const f = frameFixture();
    change(f);
    const h = f.open();
    await expect(h.capture(f.request, f.io)).rejects.toThrow(/PAPER_FRAME_/);
    await h.close();
  });
it('rejects contradictory native mode and unknown request fields before I/O', async () => {
  const f = frameFixture(),
    h = f.open();
  await expect(
    h.capture({ ...f.request, owner: { ...f.request.owner, mode: 'DEMO' } } as never, f.io),
  ).rejects.toThrow('PAPER_FRAME_INPUT');
  await expect(h.capture({ ...f.request, tenantId: randomUUID() } as never, f.io)).rejects.toThrow(
    'PAPER_FRAME_INPUT',
  );
  expect(f.ports.configuration.read).not.toHaveBeenCalled();
  await h.close();
});
it('rejects abort and expired deadlines before I/O', async () => {
  const f = frameFixture(),
    h = f.open(),
    c = new AbortController();
  c.abort();
  await expect(h.capture(f.request, { ...f.io, signal: c.signal })).rejects.toThrow(
    'PAPER_FRAME_ABORTED',
  );
  await expect(h.capture(f.request, { ...f.io, deadline: f.now })).rejects.toThrow(
    'PAPER_FRAME_ABORTED',
  );
  expect(f.ports.configuration.read).not.toHaveBeenCalled();
  await h.close();
});
it('rereads current ownership before returning and rejects changed configuration identity', async () => {
  const f = frameFixture(),
    h = f.open(),
    changed = structuredClone(f.configuration);
  changed.accountIdentity.clientIdEpoch = 'epoch-2';
  f.ports.configuration.read.mockResolvedValueOnce(f.configuration).mockResolvedValueOnce(changed);
  await expect(h.capture(f.request, f.io)).rejects.toThrow('PAPER_FRAME_CHANGED');
  await h.close();
});
it('uses the strictest model freshness and rechecks aging after all reads settle', async () => {
  const f = frameFixture();
  f.configuration.configuration.model.maxEvidenceAgeMs = 20;
  let at = f.now;
  f.ports.now = () => at;
  f.ports.configuration.read.mockImplementation(() => {
    if (f.ports.configuration.read.mock.calls.length === 2) at += 20;
    return Promise.resolve(structuredClone(f.configuration));
  });
  const h = f.open();
  await expect(h.capture(f.request, f.io)).rejects.toThrow('PAPER_FRAME_STALE');
  await h.close();
});
it('caps public evidence age at five seconds even when the model allows fifteen', async () => {
  const f = frameFixture();
  f.configuration.configuration.model.maxEvidenceAgeMs = 15000;
  const h = f.open(),
    r = await h.capture(f.request, { ...f.io, deadline: f.now + 10000 });
  expect(f.ports.snapshots.read.mock.calls[0]?.[2]).toBe(5000);
  expect(f.ports.trades.read.mock.calls[0]?.[2]).toBe(5000);
  expect(r.expiresAt).toBe(f.now + 5000);
  await h.close();
});
it('returns no capture after ambiguous COMMIT and never retries the read', async () => {
  const f = frameFixture();
  f.ports.trades.read.mockRejectedValue(new Error('MARKET_TRADE_UNCERTAIN'));
  const h = f.open();
  await expect(h.capture(f.request, f.io)).rejects.toThrow('PAPER_FRAME_UNCERTAIN');
  expect(f.ports.trades.read).toHaveBeenCalledTimes(1);
  await h.close();
});
it('sanitizes underlying database errors without exposing payloads or credentials', async () => {
  const f = frameFixture();
  f.ports.configuration.read.mockRejectedValue(new Error('postgres://secret@server sensitive SQL'));
  const h = f.open();
  await expect(h.capture(f.request, f.io)).rejects.toThrow('PAPER_FRAME_READ_FAILED');
  await h.close();
});
it('rejects calls after close and closes every owned read port', async () => {
  const f = frameFixture(),
    h = f.open();
  await h.close();
  await expect(h.capture(f.request, f.io)).rejects.toThrow('PAPER_FRAME_CLOSED');
  for (const port of [f.ports.configuration, f.ports.snapshots, f.ports.trades])
    expect(port.close).toHaveBeenCalledTimes(1);
});
for (const port of ['snapshots', 'trades'] as const)
  it('rejects ' + port + ' replacement between independent read passes', async () => {
    const f = frameFixture(),
      h = f.open();
    if (port === 'snapshots') {
      const replacement = { ...f.snapshot, revision: '2' };
      f.ports.snapshots.read.mockResolvedValueOnce(f.snapshot).mockResolvedValueOnce(replacement);
    } else {
      const replacement = { ...f.trade, revision: '2' };
      f.ports.trades.read.mockResolvedValueOnce(f.trade).mockResolvedValueOnce(replacement);
    }
    await expect(h.capture(f.request, f.io)).rejects.toThrow('PAPER_FRAME_CHANGED');
    await h.close();
  });
it('keeps four capture slots until aborted operations actually settle and then reuses them', async () => {
  const f = frameFixture(),
    releases: (() => void)[] = [];
  f.ports.configuration.read.mockImplementation(
    () => new Promise((resolve) => releases.push(() => resolve(f.configuration))),
  );
  const h = f.open(),
    controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map((c) => h.capture(f.request, { ...f.io, signal: c.signal }));
  const settled = Promise.allSettled(pending);
  for (const c of controllers) c.abort();
  await expect(h.capture(f.request, f.io)).rejects.toThrow('PAPER_FRAME_BUSY');
  expect(releases).toHaveLength(4);
  for (const release of releases) release();
  expect((await settled).every((r) => r.status === 'rejected')).toBe(true);
  f.ports.configuration.read.mockResolvedValue(f.configuration);
  await expect(h.capture(f.request, f.io)).resolves.toHaveProperty('evidence.tradeId', f.p.id);
  await h.close();
});
it('aborts a peer after failure but waits for its actual settling before returning', async () => {
  const f = frameFixture();
  let release!: () => void,
    aborted = false,
    returned = false;
  f.ports.snapshots.read.mockImplementation(
    (_key, io) =>
      new Promise((resolve) => {
        io.signal.addEventListener('abort', () => {
          aborted = true;
        });
        release = () => resolve(f.snapshot);
      }),
  );
  f.ports.trades.read.mockRejectedValue(new Error('MARKET_TRADE_UNCERTAIN'));
  const h = f.open(),
    task = h.capture(f.request, f.io).catch((error: unknown) => {
      returned = true;
      throw error;
    });
  const checked = expect(task).rejects.toThrow('PAPER_FRAME_UNCERTAIN');
  await wait(10);
  expect(aborted).toBe(true);
  expect(returned).toBe(false);
  release();
  await checked;
  await h.close();
});
it('deadline aborts underlying reads and never returns a late result', async () => {
  const f = frameFixture();
  f.ports.now = Date.now;
  let observedAbort = false;
  f.ports.configuration.read.mockImplementation(
    (_owner, io) =>
      new Promise((resolve) =>
        io.signal.addEventListener(
          'abort',
          () => {
            observedAbort = true;
            setTimeout(() => resolve(f.configuration), 10);
          },
          { once: true },
        ),
      ),
  );
  const h = f.open();
  await expect(h.capture(f.request, { ...f.io, deadline: Date.now() + 20 })).rejects.toThrow(
    'PAPER_FRAME_ABORTED',
  );
  expect(observedAbort).toBe(true);
  expect(f.ports.snapshots.read).not.toHaveBeenCalled();
  await h.close();
});
it('every concurrent close waits for underlying owned ports', async () => {
  const f = frameFixture();
  let release!: () => void;
  f.ports.trades.close.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const h = f.open();
  let first = false,
    second = false;
  const a = h.close().then(() => {
      first = true;
    }),
    b = h.close().then(() => {
      second = true;
    });
  await wait(5);
  expect(first).toBe(false);
  expect(second).toBe(false);
  release();
  await Promise.all([a, b]);
  expect(first && second).toBe(true);
  for (const p of [f.ports.configuration, f.ports.snapshots, f.ports.trades])
    expect(p.close).toHaveBeenCalledTimes(1);
});
it('deadline crossing before first I/O cannot leak a settled capture slot', async () => {
  const f = frameFixture();
  let calls = 0,
    crossing = true;
  f.ports.now = () => (crossing && ++calls >= 4 ? f.io.deadline : f.now);
  const h = f.open();
  for (let i = 0; i < 4; i++) {
    calls = 0;
    await expect(h.capture(f.request, f.io)).rejects.toThrow('PAPER_FRAME_ABORTED');
  }
  crossing = false;
  await expect(h.capture(f.request, f.io)).resolves.toHaveProperty('evidence.tradeId', f.p.id);
  await h.close();
});
it('evidence which ages out during final calculation cannot be returned', async () => {
  const f = frameFixture();
  f.configuration.configuration.model.maxEvidenceAgeMs = 20;
  let calls = 0;
  f.ports.now = () => (++calls >= 9 ? f.now + 20 : f.now);
  const h = f.open();
  await expect(h.capture(f.request, f.io)).rejects.toThrow('PAPER_FRAME_STALE');
  await h.close();
});
it('source-like error prefixes cannot leak arbitrary database text', async () => {
  const f = frameFixture();
  f.ports.configuration.read.mockRejectedValue(new Error('PAPER_FRAME_secret_password_SQL'));
  const h = f.open();
  await expect(h.capture(f.request, f.io)).rejects.toThrow('PAPER_FRAME_READ_FAILED');
  await h.close();
});
