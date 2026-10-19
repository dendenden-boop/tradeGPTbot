import { createHash } from 'node:crypto';
import {
  canonical,
  createState,
  reducePortfolio,
  type PortfolioEvent,
  type PortfolioState,
  type HoldWatermark,
} from '@ctp/portfolio';
import { fixture as marketFixture } from './fixtures.js';
export function commitmentFixture() {
  const market = marketFixture(),
    now = market.now;
  const owner = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    accountId: '22222222-2222-4222-8222-222222222222',
    mode: 'PAPER' as const,
  };
  const bookId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let state: PortfolioState = {
    ...createState({
      ...owner,
      connectionId: null,
      externalAccountId: 'paper-account',
      walletId: 'paper-initial:' + bookId,
      scope: { exchange: 'BINANCE', market: 'SPOT', region: 'global', environment: 'LIVE' },
    }),
    status: 'RECONCILED',
    snapshotAt: now - 10000,
    snapshotId: 'snapshot',
    balances: [
      { asset: 'BTC', total: '2', free: '2', locked: '0', available: '2' },
      { asset: 'USDT', total: '1000', free: '1000', locked: '0', available: '1000' },
    ],
  };
  const holdProofs = ['BTC', 'USDT'].map<
    HoldWatermark & { holdId: string; lastEvent: PortfolioEvent }
  >((asset, i) => {
    const lastEvent: Extract<PortfolioEvent, { type: 'COMMITMENT' }> = {
      type: 'COMMITMENT',
      id: 'commit-' + i,
      timestamp: now - 10,
      hold: { id: 'hold-' + i, asset, amount: '0.5', status: 'UNKNOWN', reflected: false },
    };
    const r = reducePortfolio(state, lastEvent, { now: () => now, holdWatermark: null });
    state = r.state;
    if (!r.holdWatermark) throw Error('fixture watermark');
    return {
      holdId: lastEvent.hold.id,
      ...r.holdWatermark,
      lastEvent,
    };
  });
  return {
    now,
    asOf: now,
    maxEvidenceAgeMs: 5000,
    owner,
    valuationAsset: 'USDT',
    bookId,
    revision: '9007199254740993',
    state,
    holdProofs,
    reservations: [
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        orderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        intentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        instrumentId: market.record.instrument.id,
        base: 'BTC',
        quote: 'USDT',
        side: 'SELL' as 'BUY' | 'SELL',
        notional: '8',
        notionalAsset: 'USDT',
        status: 'UNKNOWN' as 'ACTIVE' | 'UNKNOWN' | 'RELEASED',
        updatedAt: now - 10,
        debits: [
          { asset: 'BTC', amount: '0.5', holdId: 'hold-0' },
          { asset: 'USDT', amount: '0.5', holdId: 'hold-1' },
        ],
      },
    ],
  };
}
export function proofFor(event: PortfolioEvent) {
  if (!['COMMITMENT', 'RELEASE', 'RESOLVE_COMMITMENT'].includes(event.type))
    throw Error('fixture event');
  const data =
    event.type === 'COMMITMENT'
      ? { type: event.type, hold: event.hold }
      : event.type === 'RELEASE'
        ? { type: event.type, holdId: event.holdId, resolved: event.resolved }
        : event.type === 'RESOLVE_COMMITMENT'
          ? {
              type: event.type,
              hold: event.hold,
              proofId: event.proofId,
              proofHash: event.proofHash,
            }
          : null;
  return createHash('sha256').update(canonical(data)).digest('hex');
}
