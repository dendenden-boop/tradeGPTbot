import { randomUUID } from 'node:crypto';
import { parseDecimal } from '@ctp/exchange-core';
import type { OrderState, OrderEngineEvent } from '../src/domain.js';
import {
  account,
  profile,
  scope,
  order as coreOrder,
} from '../../exchange-core/test/fixtures/adapter.js';
export function state(): OrderState {
  const command = {
    instrumentId: 'BTCUSDT',
    ruleVersion: 'v1',
    clientOrderId: '1',
    side: 'BUY' as const,
    type: 'MARKET' as const,
    size: { kind: 'BASE_QUANTITY' as const, value: parseDecimal('10'), asset: 'BTC' },
    limitPrice: null,
    trigger: null,
    timeInForce: null,
    reduceOnly: false,
  };
  const { clientOrderId: _id, ...order } = command;
  void _id;
  return {
    id: randomUUID(),
    intentId: randomUUID(),
    binding: {
      tenantId: account.tenantId,
      accountId: randomUUID(),
      connectionId: account.connectionId,
      externalAccountId: account.externalAccountId,
      mode: 'TESTNET',
      profile,
    },
    draft: {
      key: 'click',
      dbInstrumentId: randomUUID(),
      dbRuleId: randomUUID(),
      positionSide: 'NET',
      bucket: 'CROSS',
      order,
    },
    command,
    status: 'CREATED',
    reconciliation: 'REQUIRED',
    version: 0,
    exchangeOrderId: null,
    filledQuantity: parseDecimal('0'),
    executedQuantity: parseDecimal('0'),
    executionNotional: parseDecimal('0'),
    averageFillPrice: null,
    lastNativeStatus: null,
    lastExchangeAt: null,
    lastObservationHash: null,
    activeAttemptId: null,
    activeOperation: null,
    createdAt: 100,
  };
}
export function native(
  s: OrderState,
  filled = '0',
  status: 'OPEN' | 'CANCELED' | 'FILLED' = 'OPEN',
  updatedAt = 500,
): OrderEngineEvent {
  return {
    type: 'NATIVE',
    order: {
      ...coreOrder,
      internalOrderId: s.id,
      intentId: s.intentId,
      account,
      scope,
      instrumentId: s.command.instrumentId,
      clientOrderId: s.command.clientOrderId,
      exchangeOrderId: 'native-1',
      side: s.command.side,
      type: s.command.type,
      quantity: parseDecimal('10'),
      filledQuantity: parseDecimal(filled),
      averageFillPrice:
        filled === '0'
          ? { state: 'UNAVAILABLE', reason: 'NO_EXECUTIONS' }
          : { state: 'AVAILABLE', value: parseDecimal('100') },
      status,
      createdAt: 100,
      updatedAt,
    },
  };
}
