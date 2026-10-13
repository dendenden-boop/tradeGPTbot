import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { decodePaperRiskPortfolioSource } from '../src/risk-portfolio-domain.js';
import { riskPortfolioFixture, uuid } from './risk-portfolio-fixtures.js';

it('complete two-account inventory retains original balances and snapshot times without Risk authority', () => {
  const w = riskPortfolioFixture(),
    r = decodePaperRiskPortfolioSource(w, w.owner, 200000);
  expect(r).toMatchObject({
    kind: w.kind,
    asOf: 200000,
    accountIds: w.accountIds,
    accounts: [
      {
        state: {
          snapshotAt: 2000,
          balances: [
            { asset: 'BTC', total: '0.000000000000000001' },
            { asset: 'USDT', total: '9007199254740993' },
          ],
        },
      },
      { state: { snapshotAt: 2000 } },
    ],
  });
  expect(Object.isFrozen(r)).toBe(true);
  expect(r).not.toHaveProperty('grant');
  expect(r).not.toHaveProperty('reservationId');
});
it('new capture time preserves stable inventory content identity and original snapshot', () => {
  const w = riskPortfolioFixture(),
    a = decodePaperRiskPortfolioSource(w, w.owner, 200000);
  const next = structuredClone(w);
  next.asOf = 200001;
  for (const b of next.books) b.asOf = 200001;
  const b = decodePaperRiskPortfolioSource(next, next.owner, 200001);
  expect(a).toHaveProperty('hash');
  expect(b).toHaveProperty('hash');
  expect((a as { hash: string }).hash).toBe((b as { hash: string }).hash);
});
it('100 complete accounts are bounded and independently represented', () => {
  const w = riskPortfolioFixture(100);
  const r = decodePaperRiskPortfolioSource(w, w.owner, 200000);
  expect(r.accountIds).toEqual(w.accountIds);
  expect(r.accounts).toHaveLength(100);
});
it('lossless per-account epochs and sequences are never rounded', () => {
  const w = riskPortfolioFixture();
  for (const b of w.books) {
    b.accountState.permissionEpoch = '9007199254740993';
    b.accountState.reconciliationEpoch = '9223372036854775807';
    b.accountState.clientIdHighWatermark = '9007199254740995';
    b.drafts[0]!.clientOrderId = '9007199254740995';
  }
  expect(decodePaperRiskPortfolioSource(w, w.owner, 200000)).toMatchObject({
    accounts: [
      { accountState: w.books[0]!.accountState },
      { accountState: w.books[1]!.accountState },
    ],
  });
});
const mutations: readonly [string, (w: ReturnType<typeof riskPortfolioFixture>) => void][] = [
  [
    'missing sibling',
    (w) => {
      w.books.pop();
    },
  ],
  [
    'missing target',
    (w) => {
      w.owner.accountId = uuid(99);
    },
  ],
  [
    'duplicate account',
    (w) => {
      w.accountIds[1] = w.accountIds[0]!;
    },
  ],
  [
    'noncanonical account order',
    (w) => {
      w.accountIds.reverse();
      w.books.reverse();
    },
  ],
  [
    'foreign tenant',
    (w) => {
      w.owner.tenantId = uuid(99);
    },
  ],
  [
    'duplicate book',
    (w) => {
      w.books[1] = structuredClone(w.books[0]!);
    },
  ],
  [
    'foreign book position',
    (w) => {
      w.books.reverse();
    },
  ],
  [
    'future inventory',
    (w) => {
      w.asOf = 200001;
    },
  ],
  [
    'incoherent book capture',
    (w) => {
      w.books[0]!.asOf--;
    },
  ],
  [
    'corrupt origin',
    (w) => {
      w.books[1]!.origin.hash = 'b'.repeat(64);
    },
  ],
  [
    'duplicate cross-account order identity',
    (w) => {
      w.books[1]!.drafts[0]!.orderId = w.books[0]!.drafts[0]!.orderId;
    },
  ],
  [
    'duplicate cross-account intent identity',
    (w) => {
      w.books[1]!.drafts[0]!.intentId = w.books[0]!.drafts[0]!.intentId;
    },
  ],
  [
    'invented grant',
    (w) => {
      Object.assign(w, { grant: { id: uuid(99) } });
    },
  ],
  [
    'empty account inventory',
    (w) => {
      w.books = [];
      w.accountIds = [];
    },
  ],
  [
    'invented epoch',
    (w) => {
      w.books[0]!.accountState.permissionEpoch = '01';
    },
  ],
];
it.each(mutations)('rejects %s wholly', (_name, change) => {
  const w = riskPortfolioFixture();
  change(w);
  expect(() => decodePaperRiskPortfolioSource(w, w.owner, 200000)).toThrow(
    'PAPER_RISK_PORTFOLIO_CORRUPT',
  );
});
it('expired capture cannot renew historical seed into current evidence', () => {
  const w = riskPortfolioFixture();
  expect(() => decodePaperRiskPortfolioSource(w, w.owner, 205001)).toThrow(
    'PAPER_RISK_PORTFOLIO_STALE',
  );
});
it('101 accounts reject rather than silently clipping the complete inventory', () => {
  const w = riskPortfolioFixture(101);
  expect(() => decodePaperRiskPortfolioSource(w, w.owner, 200000)).toThrow(
    'PAPER_RISK_PORTFOLIO_CORRUPT',
  );
});
it('oversized encoded inventory rejects even when every receipt has valid content and hash', () => {
  const w = riskPortfolioFixture(100);
  for (const book of w.books) {
    book.origin.receiptText += ' '.repeat(12000);
    book.origin.hash = createHash('sha256').update(book.origin.receiptText).digest('hex');
  }
  expect(() => decodePaperRiskPortfolioSource(w, w.owner, 200000)).toThrow(
    'PAPER_RISK_PORTFOLIO_CORRUPT',
  );
});
function drafts(w: ReturnType<typeof riskPortfolioFixture>, extra = false) {
  for (let i = 0; i < w.books.length; i++) {
    const b = w.books[i]!,
      count = i === 1 && extra ? 501 : 500;
    b.accountState.clientIdHighWatermark = String(count);
    b.drafts = Array.from({ length: count }, (_, j) => ({
      orderId: uuid(10000 + i * 1000 + j),
      intentId: uuid(20000 + i * 1000 + j),
      clientOrderId: String(j + 1),
      commandHash: 'a'.repeat(64),
      createdAt: 2001,
    }));
  }
}
it('1000 aggregate drafts remain exact without duplicate accounting', () => {
  const w = riskPortfolioFixture();
  drafts(w);
  expect(decodePaperRiskPortfolioSource(w, w.owner, 200000)).toHaveProperty('accounts');
});
it('1001 aggregate drafts reject wholly across independently valid books', () => {
  const w = riskPortfolioFixture();
  drafts(w, true);
  expect(() => decodePaperRiskPortfolioSource(w, w.owner, 200000)).toThrow(
    'PAPER_RISK_PORTFOLIO_CORRUPT',
  );
});
