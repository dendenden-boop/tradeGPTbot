import { expect, it } from 'vitest';
import { createState, type PortfolioState } from '@ctp/portfolio';
import { createHash } from 'node:crypto';
import { decodePaperBookSource } from '../src/book-source-domain.js';
import { initialPortfolioWire, receiptWire } from './initial-portfolio-fixtures.js';
import type { PaperFundingReceipt } from '../src/funding-domain.js';
function fixture() {
  const f = initialPortfolioWire(),
    funding = JSON.parse(f.wire.funding.receiptText) as PaperFundingReceipt;
  const state: PortfolioState = {
    ...createState({
      tenantId: f.owner.tenantId,
      accountId: f.owner.accountId,
      mode: 'PAPER',
      connectionId: null,
      externalAccountId: funding.accountIdentity.externalAccountId,
      walletId: 'paper-initial:' + funding.funding.id,
      scope: { exchange: 'BINANCE', market: 'SPOT', region: 'global', environment: 'LIVE' },
    }),
    balances: funding.funding.balances.map((b) => ({
      asset: b.asset,
      total: b.amount,
      free: b.amount,
      available: b.amount,
      locked: '0',
    })),
    status: 'RECONCILED',
    snapshotId: 'paper-bootstrap:' + funding.funding.id,
    snapshotAt: 2000,
  };
  const stateText = JSON.stringify(state),
    origin = {
      kind: 'INITIAL_BOOK',
      bookId: funding.funding.id,
      revision: '1',
      createdAt: 2000,
      configuration: f.wire.configuration,
      funding: f.wire.funding,
      stateText,
      stateHash: createHash('sha256').update(stateText).digest('hex'),
    };
  return {
    owner: f.owner,
    state,
    origin,
    w: {
      kind: 'PAPER_BOOK_SOURCE',
      asOf: 200000,
      origin: receiptWire(origin),
      accountState: {
        permissionEpoch: '0',
        reconciliationEpoch: '0',
        clientIdHighWatermark: '10',
        version: 0,
      },
      drafts: [
        {
          orderId: '55555555-5555-4555-8555-555555555555',
          intentId: '66666666-6666-4666-8666-666666666666',
          clientOrderId: '2',
          commandHash: 'a'.repeat(64),
          createdAt: 1005,
        },
        {
          orderId: '77777777-7777-4777-8777-777777777777',
          intentId: '88888888-8888-4888-8888-888888888888',
          clientOrderId: '10',
          commandHash: 'b'.repeat(64),
          createdAt: 1006,
        },
      ],
    },
  };
}
it('current common book capture preserves historical snapshot and exact conserved money without financial authority', () => {
  const f = fixture(),
    r = decodePaperBookSource(f.w, f.owner, 200000);
  expect(r).toMatchObject({
    kind: 'PAPER_BOOK_SOURCE',
    bookId: f.origin.bookId,
    revision: '1',
    asOf: 200000,
    state: f.state,
    drafts: f.w.drafts,
  });
  expect(r).not.toHaveProperty('grant');
  expect(r).not.toHaveProperty('reservationId');
  expect(r).not.toHaveProperty('tradeAllowed');
  expect(r).not.toHaveProperty('expiresAt');
  expect(Object.isFrozen(r)).toBe(true);
});
it('new capture time does not renew original snapshot or change unchanged content identity', () => {
  const f = fixture(),
    a = decodePaperBookSource(f.w, f.owner, 200000);
  const b = decodePaperBookSource({ ...f.w, asOf: 200001 }, f.owner, 200001);
  expect(a).toHaveProperty('hash');
  expect(b).toHaveProperty('hash');
  expect(a?.hash).toBe(b?.hash);
  expect(b?.state.snapshotAt).toBe(2000);
});
it('epochs and common client counters above Number precision remain lossless', () => {
  const f = fixture();
  Object.assign(f.w.accountState, {
    permissionEpoch: '9007199254740993',
    reconciliationEpoch: '9223372036854775807',
    clientIdHighWatermark: '9007199254740995',
  });
  if (!f.w.drafts[0] || !f.w.drafts[1]) throw Error('FIXTURE');
  f.w.drafts[0].clientOrderId = '9007199254740993';
  f.w.drafts[1].clientOrderId = '9007199254740995';
  expect(decodePaperBookSource(f.w, f.owner, 200000)).toMatchObject({
    accountState: f.w.accountState,
    drafts: f.w.drafts,
  });
});
it('pristine bootstrapped book has an explicit empty draft inventory and zero watermark', () => {
  const f = fixture();
  f.w.drafts = [];
  f.w.accountState.clientIdHighWatermark = '0';
  expect(decodePaperBookSource(f.w, f.owner, 200000)).toMatchObject({
    drafts: [],
    accountState: { clientIdHighWatermark: '0' },
  });
});
it.each(['permissionEpoch', 'reconciliationEpoch', 'clientIdHighWatermark'] as const)(
  'rejects noncanonical current %s',
  (key) => {
    const f = fixture();
    f.w.accountState[key] = '01';
    expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
  },
);
it.each(['permissionEpoch', 'reconciliationEpoch', 'clientIdHighWatermark'] as const)(
  'rejects signed-64 overflow in %s',
  (key) => {
    const f = fixture();
    f.w.accountState[key] = '9223372036854775808';
    expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
  },
);
it.each(['tenantId', 'accountId'] as const)('rejects another requested owner %s', (key) => {
  const f = fixture();
  f.owner[key] = '99999999-9999-4999-8999-999999999999';
  expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
});
it.each([200001, 194999, 1999, -1, 1.5])(
  'rejects future stale or invalid capture time %s',
  (asOf) => {
    const f = fixture();
    f.w.asOf = asOf;
    expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow();
  },
);
it('rejects capture predating the original book even when individually fresh', () => {
  const f = fixture();
  f.w.asOf = 1999;
  expect(() => decodePaperBookSource(f.w, f.owner, 2000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
});
it('rejects unknown grant-shaped input instead of treating a source as authorization', () => {
  const f = fixture();
  expect(() =>
    decodePaperBookSource({ ...f.w, grant: { decisionId: 'x' } }, f.owner, 200000),
  ).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
});
it('rejects unknown account state permission evidence', () => {
  const f = fixture();
  expect(() =>
    decodePaperBookSource(
      { ...f.w, accountState: { ...f.w.accountState, tradeAllowed: true } },
      f.owner,
      200000,
    ),
  ).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
});
it.each(['orderId', 'intentId', 'clientOrderId'] as const)(
  'rejects duplicated current draft %s',
  (key) => {
    const f = fixture();
    if (!f.w.drafts[0] || !f.w.drafts[1]) throw Error('FIXTURE');
    f.w.drafts[1][key] = f.w.drafts[0][key];
    expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
  },
);
it.each(['0', '01', '9223372036854775808', '11'])(
  'rejects invalid or unallocated current client ID %s',
  (clientOrderId) => {
    const f = fixture();
    if (!f.w.drafts[0]) throw Error('FIXTURE');
    f.w.drafts[0].clientOrderId = clientOrderId;
    expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
  },
);
it('requires numeric lossless draft ordering instead of lexical ordering', () => {
  const f = fixture();
  f.w.drafts.reverse();
  expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
});
it.each([-1, 2147483648, 1.5])('rejects invalid account revision %s', (version) => {
  const f = fixture();
  f.w.accountState.version = version;
  expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
});
it('rejects a draft received after the source capture', () => {
  const f = fixture();
  if (!f.w.drafts[0]) throw Error('FIXTURE');
  f.w.drafts[0].createdAt = 200001;
  expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
});
it('rejects a draft predating the required server configuration', () => {
  const f = fixture();
  if (!f.w.drafts[0]) throw Error('FIXTURE');
  f.w.drafts[0].createdAt = 999;
  expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
});
it('rejects an invalid command identity hash', () => {
  const f = fixture();
  if (!f.w.drafts[0]) throw Error('FIXTURE');
  f.w.drafts[0].commandHash = 'A'.repeat(64);
  expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
});
it('missing original seal checksum cannot become a current source', () => {
  const f = fixture();
  f.w.origin.hash = '0'.repeat(64);
  expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
});
it('coherent changed opening balances cannot replace original conserved state', () => {
  const f = fixture();
  const s = {
    ...f.state,
    balances: f.state.balances.map((b, n) => ({ ...b, total: n === 0 ? '2' : b.total })),
  };
  f.origin.stateText = JSON.stringify(s);
  f.origin.stateHash = createHash('sha256').update(f.origin.stateText).digest('hex');
  f.w.origin = receiptWire(f.origin);
  expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
});
it('capture kind must not pretend to be a certificate or initial funding receipt', () => {
  const f = fixture();
  f.w.kind = 'RISK_CERTIFICATE';
  expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
});
it('over-capacity current draft inventory fails wholly', () => {
  const f = fixture();
  const first = f.w.drafts[0];
  if (!first) throw Error('FIXTURE');
  f.w.drafts = Array.from({ length: 1001 }, () => ({ ...first }));
  expect(() => decodePaperBookSource(f.w, f.owner, 200000)).toThrow('PAPER_BOOK_SOURCE_CORRUPT');
});
