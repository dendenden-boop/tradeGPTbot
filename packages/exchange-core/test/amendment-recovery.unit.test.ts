import { afterEach, expect, it } from 'vitest';
import {
  createExchangeAdapter,
  type ExchangeAdapter,
  type RequestContext,
} from '../src/adapter.js';
import { createInstrumentRegistry } from '../src/registry.js';
import { operations } from '../src/operations.js';
import { parseDecimal } from '../src/decimal.js';
import {
  NOW,
  account,
  capabilities,
  instrument,
  operationFixtures,
  profile,
  rules,
} from './fixtures/adapter.js';

const adapters: ExchangeAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.disconnect()));
});
function fixture() {
  const registry = createInstrumentRegistry({ capacity: 1 });
  expect(registry.put({ instrument, rules }, NOW).ok).toBe(true);
  const command = operations.amendOrder.input.parse(operationFixtures.amendOrder.input).command;
  const proof = {
    account,
    scope: instrument.scope,
    instrumentId: instrument.id,
    kind: 'APPLIED_EVIDENCE',
    receivedAt: NOW,
    evidence: {
      executionId: '9007199254740993',
      time: NOW,
      exchangeOrderId: command.locator.locator.id,
      oldClientOrderId: command.target.current.clientOrderId,
      newClientOrderId: command.replacement.clientOrderId,
      originalQuantity: command.target.current.size.value,
      newQuantity: command.replacement.size.value,
    },
  };
  const adapter = createExchangeAdapter({
    profile,
    account,
    capabilities,
    adapterVersion: 'v1',
    registry,
    now: () => NOW,
    transport: {
      request: () => Promise.resolve(proof),
      subscribe: () => Promise.resolve(() => Promise.resolve()),
      disconnect: () => Promise.resolve(),
    },
  });
  adapters.push(adapter);
  const context: RequestContext = {
    profile,
    account,
    signal: new AbortController().signal,
    deadline: NOW + 1000,
    correlationId: 'causal-recovery',
  };
  const lookup = adapter.getAmendmentEvidence;
  return { registry, adapter, command, proof, context, lookup };
}
it('offers bounded read-only causal recovery after rules replacement without a mutation permit', async () => {
  const f = fixture();
  expect(f.lookup).toBeTypeOf('function');
  if (!f.lookup) throw new Error('AMENDMENT_RECOVERY_CONTRACT_MISSING');
  expect(
    f.registry.put(
      { instrument: { ...instrument, metadataVersion: 'v2' }, rules: { ...rules, version: 'v2' } },
      NOW,
    ).ok,
  ).toBe(true);
  const result = await f.lookup({ command: f.command }, f.context);
  expect(result).toEqual({ ok: true, value: f.proof });
});
it.each([
  'client',
  'old-client',
  'order',
  'quantity',
  'time',
  'future-time',
  'future-receipt',
  'instrument',
  'account',
  'execution-number',
] as const)('rejects mismatching %s causal proof before recovery can adopt it', async (kind) => {
  const f = fixture();
  expect(f.lookup).toBeTypeOf('function');
  if (!f.lookup) throw new Error('AMENDMENT_RECOVERY_CONTRACT_MISSING');
  if (kind === 'client') f.proof.evidence.newClientOrderId = 'another-client';
  if (kind === 'old-client') f.proof.evidence.oldClientOrderId = 'another-client';
  if (kind === 'order') f.proof.evidence.exchangeOrderId = 'another-order';
  if (kind === 'quantity') f.proof.evidence.newQuantity = parseDecimal('0.0001');
  if (kind === 'time') f.proof.evidence.time = f.command.target.nativeUpdatedAt - 1;
  if (kind === 'future-time') f.proof.evidence.time = NOW + 1;
  if (kind === 'future-receipt') f.proof.receivedAt = NOW + 1;
  if (kind === 'instrument') f.proof.instrumentId = 'another-instrument';
  if (kind === 'account') f.proof.account = { ...account, externalAccountId: 'another-account' };
  if (kind === 'execution-number') Reflect.set(f.proof.evidence, 'executionId', 9007199254740992);
  expect(await f.lookup({ command: f.command }, f.context)).toMatchObject({
    ok: false,
    error: { code: kind === 'execution-number' ? 'INVALID_RESPONSE' : 'SCOPE_MISMATCH' },
  });
});

it('rejects an aborted causal read before accessing transport', async () => {
  const f = fixture();
  expect(
    await f.lookup({ command: f.command }, { ...f.context, signal: AbortSignal.abort() }),
  ).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
});
