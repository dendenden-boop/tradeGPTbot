import { createHash, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { tradeFixture } from '../../market-data/test/trade-fixture.js';
import { snapshotFixture } from '../../market-data/test/snapshot-fixture.js';
import { paperConfigurationReceiptSchema } from '../src/configuration-domain.js';
import { fixture } from './fixtures.js';
import type { FrameReadPorts } from '../src/frame-domain.js';
import * as candidate from '../src/frame-reader.js';

export function frameFixture() {
  const p = tradeFixture(),
    s = snapshotFixture(),
    now = p.timestamp;
  s.key = structuredClone(p.key);
  s.record = structuredClone(p.record);
  s.timestamp = now;
  s.book.scope = p.key.scope;
  s.book.instrumentId = p.key.instrumentId;
  s.book.receivedAt = now;
  s.book.exchangeTime = now;
  s.ticker.scope = p.key.scope;
  s.ticker.instrumentId = p.key.instrumentId;
  s.ticker.receivedAt = now;
  s.ticker.exchangeTime = now;
  const configuration = paperConfigurationReceiptSchema.parse({
    configuration: {
      id: randomUUID(),
      owner: { tenantId: randomUUID(), accountId: randomUUID(), mode: 'PAPER' },
      source: structuredClone(p.key.scope),
      model: fixture().model,
      valuationAsset: 'USDT',
    },
    accountIdentity: { externalAccountId: 'paper:test', clientIdEpoch: 'epoch-1' },
    createdAt: now,
  });
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const snapshot = { id: s.id, revision: '1', hash: hash(s), publication: s };
  const trade = { id: p.id, revision: '1', hash: hash(p), publication: p };
  const ports = {
    configuration: {
      read: vi.fn<FrameReadPorts['configuration']['read']>(() =>
        Promise.resolve(structuredClone(configuration)),
      ),
      close: vi.fn(async () => {}),
    },
    snapshots: {
      read: vi.fn<FrameReadPorts['snapshots']['read']>(() =>
        Promise.resolve(structuredClone(snapshot)),
      ),
      close: vi.fn(async () => {}),
    },
    trades: {
      read: vi.fn<FrameReadPorts['trades']['read']>(() => Promise.resolve(structuredClone(trade))),
      close: vi.fn(async () => {}),
    },
    now: () => now,
  };
  const open = () => {
    const create = candidate.createPaperFrameReader;
    if (typeof create !== 'function') throw new Error('PAPER_FRAME_FACTORY_MISSING');
    return create(ports);
  };
  return {
    p,
    s,
    snapshot,
    trade,
    configuration,
    ports,
    open,
    now,
    request: {
      owner: structuredClone(configuration.configuration.owner),
      key: structuredClone(p.key),
    },
    io: { signal: new AbortController().signal, deadline: now + 2500 },
  };
}
