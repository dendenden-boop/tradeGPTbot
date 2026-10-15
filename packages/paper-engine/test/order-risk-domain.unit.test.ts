import { expect, it } from 'vitest';
import { canonical } from '@ctp/portfolio';
import { decodePaperOrderRiskSource } from '../src/order-risk-domain.js';
import { orderRiskFixture } from './order-risk-fixtures.js';

it('binds original durable intent/command/book and current heads to exact conservative debits', () => {
  const f = orderRiskFixture();
  const r = decodePaperOrderRiskSource(f.wire, f.request, 200000);
  expect(r).toMatchObject({
    kind: 'PAPER_ORDER_RISK_SOURCE',
    target: { orderId: f.wire.target.orderId, intentId: f.request.intentId, command: f.command },
    envelope: { debits: [{ asset: 'USDT', amount: '5.25525' }] },
    book: { state: { snapshotAt: 2000 } },
    validUntil: 205001,
  });
  expect(Object.isFrozen(r.envelope.debits)).toBe(true);
  expect(r).not.toHaveProperty('certificate');
  expect(r).not.toHaveProperty('grant');
});
it.each([
  'owner',
  'intent',
  'order',
  'hash',
  'command',
  'binding',
  'clientId',
  'missing-draft',
  'snapshot-hash',
  'trade-hash',
  'snapshot-id',
  'trade-id',
  'rule-id',
  'record',
  'scope',
  'gap',
  'stale-book',
  'stale-trade',
  'future',
  'expired-rules',
  'command-rules',
  'unknown',
  'oversize',
] as const)('%s cannot yield a partial order-risk source', (kind) => {
  const f = orderRiskFixture(),
    w = f.wire;
  if (kind === 'owner') f.request.owner.accountId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  if (kind === 'intent') f.request.intentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  if (kind === 'order') w.target.orderId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  if (kind === 'hash') w.target.commandHash = 'b'.repeat(64);
  if (kind === 'command') w.target.commandText = w.target.commandText.replace('10.5', '10.6');
  if (kind === 'binding')
    w.target.bindingText = canonical({ ...f.binding, connectionId: w.target.orderId });
  if (kind === 'clientId') w.book.drafts[0]!.clientOrderId = '2';
  if (kind === 'missing-draft') w.book.drafts = [];
  if (kind === 'snapshot-hash') w.snapshot.hash = 'b'.repeat(64);
  if (kind === 'trade-hash') w.trade.hash = 'b'.repeat(64);
  if (kind === 'snapshot-id') w.snapshot.id = w.target.orderId;
  if (kind === 'trade-id') w.trade.id = w.target.orderId;
  if (kind === 'rule-id') w.target.dbRuleId = w.target.orderId;
  if (kind === 'record') f.f.p.record.instrument.exchangeSymbol += '-foreign';
  if (kind === 'scope') f.f.p.trade.scope = { ...f.f.p.trade.scope, region: 'other' };
  if (kind === 'gap') Object.assign(f.f.s, { kind: 'GAP', reason: 'TEST_GAP' });
  if (kind === 'stale-book') f.f.s.book.exchangeTime = 194999;
  if (kind === 'stale-trade') f.f.p.trade.exchangeTime = 194999;
  if (kind === 'future') f.f.p.trade.receivedAt = 200001;
  if (kind === 'expired-rules') f.f.s.record.rules.expiresAt = 200000;
  if (kind === 'command-rules') f.command.ruleVersion = 'replacement';
  if (kind === 'unknown') Object.assign(w, { grant: {} });
  if (kind === 'oversize') w.target.commandText += ' '.repeat(1048576);
  if (
    ['record', 'scope', 'gap', 'stale-book', 'stale-trade', 'future', 'expired-rules'].includes(
      kind,
    )
  ) {
    w.snapshot = f.publication(f.f.s);
    w.trade = f.publication(f.f.p);
  }
  if (kind === 'command-rules') w.target.commandText = canonical(f.command);
  expect(() => decodePaperOrderRiskSource(w, f.request, 200000)).toThrow(/PAPER_ORDER_RISK_/);
});
it('preserves lossless head revisions and native sequences over MAX_SAFE_INTEGER', () => {
  const f = orderRiskFixture();
  f.wire.trade.revision = f.wire.snapshot.revision = '9007199254740993';
  const r = decodePaperOrderRiskSource(f.wire, f.request, 200000);
  expect(r.evidence.trade.revision).toBe('9007199254740993');
  expect(r.envelope.record.instrument.id).toBe(f.command.instrumentId);
});
it('expiry uses the oldest native evidence and current rule expiry', () => {
  const f = orderRiskFixture();
  f.f.p.trade.exchangeTime = 198000;
  f.wire.trade = f.publication(f.f.p);
  expect(decodePaperOrderRiskSource(f.wire, f.request, 200000).validUntil).toBe(203001);
  f.f.s.record.rules.expiresAt = f.f.p.record.rules.expiresAt = 200010;
  f.wire.snapshot = f.publication(f.f.s);
  f.wire.trade = f.publication(f.f.p);
  expect(decodePaperOrderRiskSource(f.wire, f.request, 200000).validUntil).toBe(200010);
});
it('replay preserves the original command, book snapshot and capture identities', () => {
  const f = orderRiskFixture(),
    a = decodePaperOrderRiskSource(f.wire, f.request, 200000),
    b = decodePaperOrderRiskSource(structuredClone(f.wire), f.request, 200001);
  expect(b).toEqual(a);
});
