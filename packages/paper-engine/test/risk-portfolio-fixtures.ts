import { randomUUID } from 'node:crypto';
import { createState } from '@ctp/portfolio';
import { initialPortfolioWire, receiptWire } from './initial-portfolio-fixtures.js';
import { paperConfigurationReceiptSchema } from '../src/configuration-domain.js';
import { paperFundingReceiptSchema } from '../src/funding-domain.js';

export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as const;
export function riskBook(accountId: string) {
  const f = initialPortfolioWire(),
    owner = { ...f.owner, accountId };
  const c = paperConfigurationReceiptSchema.parse(JSON.parse(f.wire.configuration.receiptText));
  const config = {
    ...c,
    configuration: { ...c.configuration, id: randomUUID(), owner },
    accountIdentity: {
      externalAccountId: 'paper:' + accountId,
      clientIdEpoch: 'epoch:' + accountId,
    },
  };
  const cw = receiptWire(config),
    p = paperFundingReceiptSchema.parse(JSON.parse(f.wire.funding.receiptText));
  const funding = {
    ...p,
    funding: { ...p.funding, id: randomUUID(), owner, configurationId: config.configuration.id },
    configurationHash: cw.hash,
    accountIdentity: config.accountIdentity,
  };
  funding.ledgerTransactionId = funding.funding.id;
  const state = {
    ...createState({
      tenantId: owner.tenantId,
      accountId,
      mode: 'PAPER',
      connectionId: null,
      externalAccountId: config.accountIdentity.externalAccountId,
      walletId: 'paper-initial:' + funding.funding.id,
      scope: config.configuration.source,
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
  const sw = receiptWire(state),
    origin = receiptWire({
      kind: 'INITIAL_BOOK',
      bookId: funding.funding.id,
      revision: '1',
      createdAt: 2000,
      configuration: cw,
      funding: receiptWire(funding),
      stateText: sw.receiptText,
      stateHash: sw.hash,
    });
  return {
    kind: 'PAPER_BOOK_SOURCE',
    asOf: 200000,
    origin,
    accountState: {
      permissionEpoch: '0',
      reconciliationEpoch: '0',
      clientIdHighWatermark: '1',
      version: 0,
    },
    drafts: [
      {
        orderId: randomUUID(),
        intentId: randomUUID(),
        clientOrderId: '1',
        commandHash: 'a'.repeat(64),
        createdAt: 2001,
      },
    ],
  };
}
export function riskPortfolioFixture(count = 2) {
  const accountIds = Array.from({ length: count }, (_, i) => uuid(i + 1));
  return {
    kind: 'PAPER_RISK_PORTFOLIO_SOURCE',
    owner: { ...initialPortfolioWire().owner, accountId: accountIds[0]! },
    asOf: 200000,
    accountIds,
    books: accountIds.map(riskBook),
  };
}
