import { randomUUID } from 'node:crypto';
import { createState } from '@ctp/portfolio';
import { marketSnapshotPublicationSchema } from '@ctp/market-data';
import { normalizedFixtures } from '../../exchange-core/test/fixtures/domain.js';
import { executedBookFixture } from './executed-book-fixtures.js';
import { receiptWire } from './initial-portfolio-fixtures.js';
import { paperConfigurationReceiptSchema } from '../src/configuration-domain.js';
import { paperFundingReceiptSchema } from '../src/funding-domain.js';

export function historicalInventoryFixture(count = 2) {
  const f = executedBookFixture(),
    now = f.now + 20000;
  const request = { ...f.request, kind: 'PAPER_HISTORICAL_INVENTORY_CAPTURE' };
  const target = request.admission.binding.accountId;
  const owner = {
    tenantId: request.admission.binding.tenantId,
    accountId: target,
    mode: 'PAPER' as const,
  };
  const rawConfig = paperConfigurationReceiptSchema.parse(
    JSON.parse(f.packet.source.started.context.configuration.receiptText),
  );
  const native = normalizedFixtures(),
    record = f.packet.input.frame.record;
  const publication = marketSnapshotPublicationSchema.parse({
    kind: 'SNAPSHOT',
    id: randomUUID(),
    expectedRevision: '9007199254740993',
    timestamp: now,
    key: {
      scope: record.instrument.scope,
      instrumentId: record.instrument.id,
      dbInstrumentId: request.admission.dbInstrumentId,
      dbRuleId: request.admission.dbRuleId,
    },
    record,
    ticker: {
      ...native.ticker,
      last: { state: 'AVAILABLE', value: '12.05' },
      exchangeTime: now,
      receivedAt: now,
    },
    book: { ...f.packet.input.frame.book, exchangeTime: now, receivedAt: now },
  });
  if (publication.kind !== 'SNAPSHOT') throw Error('HISTORICAL_FIXTURE');
  const market = () => {
    const w = receiptWire(publication);
    return {
      id: publication.id,
      revision: '9007199254740994',
      hash: w.hash,
      publicationText: w.receiptText,
    };
  };
  const executed = {
    kind: 'PAPER_EXECUTED_VALUATION_CAPTURE',
    request: { ...request, kind: 'PAPER_EXECUTED_VALUATION_CAPTURE' },
    asOf: now,
    execution: f.packet,
    markets: [market()],
  };
  const books = Array.from({ length: count - 1 }, () => {
    const accountId = randomUUID(),
      configurationId = randomUUID(),
      fundingId = randomUUID();
    const siblingOwner = { ...owner, accountId };
    const identity = { externalAccountId: 'sibling:' + accountId, clientIdEpoch: 'sibling-epoch' };
    const config = receiptWire({
      ...rawConfig,
      configuration: {
        ...rawConfig.configuration,
        id: configurationId,
        owner: siblingOwner,
      },
      accountIdentity: identity,
      createdAt: f.now - 10,
    });
    const funding = receiptWire(
      paperFundingReceiptSchema.parse({
        funding: {
          id: fundingId,
          owner: siblingOwner,
          configurationId,
          balances: [{ asset: 'USDT', amount: '100' }],
        },
        configurationHash: config.hash,
        accountIdentity: identity,
        ledgerTransactionId: fundingId,
        createdAt: f.now - 5,
      }),
    );
    const state = {
      ...createState({
        ...siblingOwner,
        connectionId: null,
        externalAccountId: identity.externalAccountId,
        walletId: 'paper-initial:' + fundingId,
        scope: rawConfig.configuration.source,
      }),
      balances: [{ asset: 'USDT', total: '100', free: '100', available: '100', locked: '0' }],
      snapshotId: 'paper-bootstrap:' + fundingId,
      snapshotAt: f.now - 1,
      status: 'RECONCILED',
    };
    const stateWire = receiptWire(state);
    const origin = receiptWire({
      kind: 'INITIAL_BOOK',
      bookId: fundingId,
      revision: '1',
      createdAt: f.now - 1,
      configuration: config,
      funding,
      stateText: stateWire.receiptText,
      stateHash: stateWire.hash,
    });
    return {
      accountId,
      book: {
        kind: 'PAPER_BOOK_SOURCE',
        asOf: now,
        origin,
        accountState: {
          permissionEpoch: '0',
          reconciliationEpoch: '0',
          clientIdHighWatermark: '0',
          version: 0,
        },
        drafts: [] as {
          orderId: string;
          intentId: string;
          clientOrderId: string;
          commandHash: string;
          createdAt: number;
        }[],
      },
    };
  }).sort((a, b) => a.accountId.localeCompare(b.accountId));
  const accountIds = [target, ...books.map((b) => b.accountId)].sort();
  const catalog = accountIds.map((accountId) => ({
    accountId,
    ...(accountId === target
      ? {
          permissionEpoch: request.authorization.permissionEpoch,
          reconciliationEpoch: '0',
          clientIdHighWatermark: '1',
          version: 0,
        }
      : books.find((b) => b.accountId === accountId)!.book.accountState),
  }));
  const wire = {
    kind: request.kind,
    request,
    asOf: now,
    accountIds,
    catalog,
    executed,
    books,
    markets: [market()],
  };
  return { ...f, now, request, wire, publication, market, owner };
}
