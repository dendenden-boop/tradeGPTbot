import { expect, it } from 'vitest';
import { captureFixture } from './snapshot-fixtures.js';
import { decodeRiskSnapshotCapture } from '../src/snapshot-capture.js';
import { prepareRiskSnapshot } from '../src/coordinator.js';
import { randomUUID, createHash } from 'node:crypto';
it('composes all nine durable source families with native sequence-only Spot depth and the actual loss checkpoint text/hash', () => {
  const f = captureFixture();
  const s = decodeRiskSnapshotCapture(f.raw, f.key, f.now);
  expect(Object.keys(s)).toHaveLength(9);
  expect(s.market.value.kind).toBe('LAST');
  expect(s.market.value.asOf).toBe(f.now);
  const p = prepareRiskSnapshot(s, f.key, { id: randomUUID(), revision: '1' }, f.now);
  expect(p.snapshot).toMatchObject({
    availableAmount: '1000',
    userExposure: '0',
    adjustedCurrentEquity: '1000',
    dailyNetRealizedPnl: '0',
  });
});
it.each(['tenant', 'connection', 'mode', 'intent', 'rule'] as const)(
  'rejects contradictory durable %s evidence',
  (kind) => {
    const f = captureFixture();
    if (kind === 'tenant') f.raw.user.id = randomUUID();
    if (kind === 'connection') f.raw.connection.id = randomUUID();
    if (kind === 'mode') f.raw.connection.mode = 'DEMO';
    if (kind === 'intent') f.raw.intent.id = randomUUID();
    if (kind === 'rule') f.raw.intent.command.ruleVersion = 'obsolete';
    expect(() => decodeRiskSnapshotCapture(f.raw, f.key, f.now)).toThrow(/^RISK_/);
  },
);
it('never extends native evidence age at later capture time', () => {
  const f = captureFixture();
  expect(() => decodeRiskSnapshotCapture(f.raw, f.key, f.now + 5001)).toThrow(
    'RISK_SNAPSHOT_STALE',
  );
});
it('requires exact observed FX rather than guessing stablecoin parity', () => {
  const f = captureFixture();
  f.observation.fx[0]!.from = 'USDC';
  f.rehashObservation();
  expect(() => decodeRiskSnapshotCapture(f.raw, f.key, f.now)).toThrow('RISK_SNAPSHOT_FX');
});
it('rejects a book with neither sequence nor native time', () => {
  const f = captureFixture();
  const book = { ...f.publication.book, sourceSequence: null };
  f.raw.markets[0]!.text = JSON.stringify({ ...f.publication, book });
  f.raw.markets[0]!.hash = createHash('sha256').update(f.raw.markets[0]!.text).digest('hex');
  expect(() => decodeRiskSnapshotCapture(f.raw, f.key, f.now)).toThrow(/^RISK_/);
});
