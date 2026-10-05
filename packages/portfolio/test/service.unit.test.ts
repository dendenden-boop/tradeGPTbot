import { expect, it } from 'vitest';
import { createPortfolioAccount } from '../src/service.js';
import { createState, reducePortfolio } from '../src/accounting.js';
import type { Binding, Checkpoint, PortfolioStore, PortfolioEvent } from '../src/domain.js';
import type { InstrumentRegistry } from '@ctp/exchange-core';
import { registry as makeRegistry } from '../../market-data/test/fixtures.js';
import { failure } from '@ctp/exchange-core';
import { binding, snapshot, context } from './fixtures.js';

function store(): PortfolioStore & { get(): Checkpoint } {
  let cp: Checkpoint = { revision: 0, state: createState(binding()) };
  const identities = new Map<string, string>();
  return {
    evidence: (_b: Binding, ids: readonly string[]) =>
      Promise.resolve(
        ids.map((id) => ({
          event: JSON.parse(identities.get(id) ?? 'null') as PortfolioEvent,
          ledgerId: null,
        })),
      ),
    get: () => cp,
    read: () => Promise.resolve(structuredClone(cp)),
    apply: async (_b: Binding, e: PortfolioEvent, rev: number) => {
      await Promise.resolve();
      const encoded = JSON.stringify(e),
        old = identities.get(e.id);
      if (old) {
        if (old !== encoded) throw new Error('EVIDENCE_CONFLICT');
        return { checkpoint: structuredClone(cp), duplicate: true };
      }
      if (rev !== cp.revision) throw new Error('REVISION_CONFLICT');
      cp = { revision: cp.revision + 1, state: reducePortfolio(cp.state, e, context).state };
      identities.set(e.id, encoded);
      return { checkpoint: structuredClone(cp), duplicate: false };
    },
    events: () => Promise.resolve([]),
    acknowledge: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}
function setup() {
  const s = store();
  const b = binding();
  const registry: InstrumentRegistry = makeRegistry(1);
  const source = {
    snapshot: () => Promise.resolve(snapshot()),
    executionContext: () =>
      Promise.resolve({
        side: 'BUY' as const,
        positionSide: 'NET' as const,
        bucket: 'CROSS',
        metadataVersion: 'metadata-0',
        ruleVersion: 'rules-0',
      }),
    feeFx: () => Promise.resolve(null),
  };
  return { s, b, registry, source };
}
const options = (x: ReturnType<typeof setup>) => ({
  authorization: { check: () => Promise.resolve(true) },
  binding: x.b,
  store: x.s,
  registry: x.registry,
  source: x.source,
  now: () => 1000,
});
function nativeFill(b: Binding) {
  return {
    account: {
      tenantId: b.tenantId,
      connectionId: b.connectionId,
      externalAccountId: b.externalAccountId,
    },
    scope: b.scope,
    exchangeTime: 1000,
    receivedAt: 1000,
    instrumentId: 'BTCUSDT',
    fillId: '90071992547409931',
    identityScope: 'native-trade',
    internalOrderId: '44444444-4444-4444-8444-444444444444',
    exchangeOrderId: 'native-order',
    price: '100',
    quantity: '1',
    quantityUnit: 'BASE',
    fees: [],
  };
}
it('applies normalized native fills once and rejects a different tenant', async () => {
  const x = setup();
  const a = createPortfolioAccount(options(x));
  await a.reconcile();
  const native = nativeFill(x.b);
  await a.ingestFill(native);
  const replay = await a.ingestFill({ ...native, receivedAt: 1001 });
  expect(replay.duplicate).toBe(true);
  expect(x.s.get().state.positions[0]?.quantity).toBe('1');
  await expect(
    a.ingestFill({
      ...native,
      account: { ...native.account, tenantId: '55555555-5555-4555-8555-555555555555' },
    }),
  ).rejects.toThrow('PORTFOLIO_SCOPE_MISMATCH');
});
it('rechecks metadata after asynchronous fee provenance before accounting commit', async () => {
  const x = setup();
  let calls = 0;
  const registry: InstrumentRegistry = {
    get: (scope, id, now) =>
      ++calls === 1 ? x.registry.get(scope, id, now) : failure('STALE_METADATA'),
  };
  const a = createPortfolioAccount({ ...options(x), registry });
  await a.reconcile();
  await expect(
    a.ingestFill({ ...nativeFill(x.b), fees: [{ asset: 'BNB', amount: '0.01', kind: 'TRADING' }] }),
  ).rejects.toThrow('STALE_METADATA');
  expect(x.s.get().revision).toBe(1);
});
it('holds account close until its aborted source has actually settled', async () => {
  const x = setup();
  let entered = () => {};
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const source = {
    ...x.source,
    snapshot: (_b: Binding, _cp: Checkpoint, c: { signal: AbortSignal }) =>
      new Promise<ReturnType<typeof snapshot>>((_, reject) => {
        entered();
        c.signal.addEventListener(
          'abort',
          () => setTimeout(() => reject(new Error('ABORTED')), 50),
          { once: true },
        );
      }),
  };
  const a = createPortfolioAccount({ ...options(x), source });
  const result = a.reconcile().catch((e: unknown) => e);
  await ready;
  const started = Date.now();
  await a.close();
  expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  expect(await result).toBeInstanceOf(Error);
});
it('denies forged server bindings before accessing financial storage', async () => {
  const x = setup();
  const a = createPortfolioAccount({
    ...options(x),
    authorization: { check: () => Promise.resolve(false) },
  });
  await expect(a.read()).rejects.toThrow('PORTFOLIO_AUTHORIZATION_DENIED');
  expect(x.s.get().revision).toBe(0);
});
it('checks revocation on every operation and sanitizes external reader errors', async () => {
  const x = setup();
  let authorized = true;
  const a = createPortfolioAccount({
    ...options(x),
    authorization: { check: () => Promise.resolve(authorized) },
  });
  await a.reconcile();
  authorized = false;
  await expect(a.read()).rejects.toThrow('PORTFOLIO_AUTHORIZATION_DENIED');
  const b = createPortfolioAccount({
    ...options(x),
    source: { ...x.source, snapshot: () => Promise.reject(new Error('RAW_CREDENTIAL_SENTINEL')) },
  });
  const error = await b.reconcile().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain('RAW_CREDENTIAL_SENTINEL');
});
it('requires fresh reconciliation after service recreation', async () => {
  const x = setup();
  const a = createPortfolioAccount(options(x));
  await a.reconcile();
  expect((await a.read()).reconciledAfterRestart).toBe(true);
  const restarted = createPortfolioAccount(options(x));
  expect((await restarted.read()).reconciledAfterRestart).toBe(false);
});
it('retains durable duplicate protection across service recreation', async () => {
  const x = setup();
  const a = createPortfolioAccount(options(x));
  await a.reconcile();
  const before = x.s.get().revision;
  await a.reconcile();
  expect(x.s.get().revision).toBe(before);
});
it('does not apply a snapshot whose revision raced with a gap', async () => {
  const x = setup();
  const source = {
    ...x.source,
    snapshot: async () => {
      await x.s.apply(x.b, { type: 'GAP', id: 'gap', timestamp: 1000 }, 0, {
        signal: new AbortController().signal,
        deadline: Date.now() + 3000,
      });
      return snapshot();
    },
  };
  const a = createPortfolioAccount({ ...options(x), source });
  await expect(a.reconcile()).rejects.toThrow('REVISION_CONFLICT');
  expect(x.s.get().state.status).toBe('GAP');
});
it('aborts hung source boundedly and never freshens account', async () => {
  const x = setup();
  let aborted = false;
  const source = {
    ...x.source,
    snapshot: (_b: Binding, _c: Checkpoint, c: { signal: AbortSignal }) =>
      new Promise<ReturnType<typeof snapshot>>((_, reject) =>
        c.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('ABORTED'));
          },
          { once: true },
        ),
      ),
  };
  const a = createPortfolioAccount({ ...options(x), source, operationTimeoutMs: 25 });
  await expect(a.reconcile()).rejects.toThrow();
  expect(aborted).toBe(true);
  expect((await a.read()).reconciledAfterRestart).toBe(false);
});
it('rejects raw URLs and credentials in server factory options', () => {
  const x = setup();
  expect(() =>
    createPortfolioAccount({ ...options(x), url: 'https://example.invalid' } as Parameters<
      typeof createPortfolioAccount
    >[0]),
  ).toThrow('INVALID_PORTFOLIO_OPTIONS');
});
