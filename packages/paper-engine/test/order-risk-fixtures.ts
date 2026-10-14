import { createHash } from 'node:crypto';
import { canonical } from '@ctp/portfolio';
import { newOrderSchema } from '@ctp/exchange-core';
import { riskPortfolioFixture } from './risk-portfolio-fixtures.js';
import { frameFixture } from './frame-fixture.js';
import { paperConfigurationReceiptSchema } from '../src/configuration-domain.js';

export function orderRiskFixture() {
  const inventory = riskPortfolioFixture(1),
    book = inventory.books[0]!,
    f = frameFixture(),
    origin = JSON.parse(book.origin.receiptText) as { configuration: { receiptText: string } },
    config = paperConfigurationReceiptSchema.parse(JSON.parse(origin.configuration.receiptText)),
    scope = config.configuration.source;
  for (const p of [f.p, f.s]) {
    p.key.scope = scope;
    p.record.instrument.scope = scope;
    p.record.rules.scope = scope;
    p.record.rules.effectiveAt = 199000;
    p.record.rules.expiresAt = 260000;
    p.timestamp = 200000;
  }
  for (const v of [f.s.book, f.s.ticker, f.p.trade]) {
    v.scope = scope;
    v.receivedAt = v.exchangeTime = 200000;
  }
  const binding = {
    ...inventory.owner,
    connectionId: null,
    externalAccountId: config.accountIdentity.externalAccountId,
    profile: {
      ...scope,
      accountMode: 'SIMULATED',
      endpointProfileId: 'paper-spot-v1',
      profileVersion: config.configuration.model.version,
    },
  };
  const command = newOrderSchema.parse({
    instrumentId: f.p.record.instrument.id,
    ruleVersion: f.p.record.rules.version,
    clientOrderId: '1',
    side: 'BUY',
    type: 'LIMIT',
    size: { kind: 'BASE_QUANTITY', asset: 'BTC', value: '0.5' },
    limitPrice: '10.5',
    timeInForce: 'GTC',
    trigger: null,
    reduceOnly: false,
  });
  const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
  const target = {
    orderId: book.drafts[0]!.orderId,
    intentId: book.drafts[0]!.intentId,
    dbInstrumentId: f.p.key.dbInstrumentId,
    dbRuleId: f.p.key.dbRuleId,
    bindingText: canonical(binding),
    commandText: canonical(command),
    commandHash: hash({ operation: 'createOrder', command, binding }),
  };
  book.drafts[0]!.commandHash = target.commandHash;
  const publication = (value: unknown, revision = '1') => {
    const publicationText = JSON.stringify(value);
    return {
      id: (value as { id: string }).id,
      revision,
      publicationText,
      hash: createHash('sha256').update(publicationText).digest('hex'),
    };
  };
  const request = {
    owner: { ...inventory.owner, accountId: String(inventory.owner.accountId) },
    intentId: target.intentId,
  };
  const wire = {
    kind: 'PAPER_ORDER_RISK_CAPTURE',
    asOf: 200000,
    book,
    target,
    snapshot: publication(f.s),
    trade: publication(f.p),
  };
  return { wire, request, command, binding, f, publication };
}
