import { createHash } from 'node:crypto';
import {
  fillSchema,
  fundingSchema,
  decimalMultiply,
  parseDecimal,
  sameMarketScope,
  immutable,
  errorCodeSchema as exchangeErrorCodeSchema,
  type Fill,
  type Funding,
  type InstrumentRegistry,
} from '@ctp/exchange-core';
import {
  bindingSchema,
  canonical,
  type Binding,
  type Checkpoint,
  type PortfolioStore,
  type SnapshotEvent,
  type FillEvent,
  type IoContext,
  type PortfolioEvidence,
} from './domain.js';
export interface PortfolioReadSource {
  snapshot(
    binding: Binding,
    checkpoint: Checkpoint & { pendingEvidence: readonly PortfolioEvidence[] },
    context: IoContext,
  ): Promise<SnapshotEvent>;
  executionContext(
    binding: Binding,
    fill: Fill,
    context: IoContext,
  ): Promise<{
    side: 'BUY' | 'SELL';
    positionSide: 'NET' | 'LONG' | 'SHORT';
    bucket: string;
    metadataVersion: string;
    ruleVersion: string;
  }>;
  feeFx(
    binding: Binding,
    asset: string,
    quote: string,
    timestamp: number,
    context: IoContext,
  ): Promise<{ rate: string; asOf: number; sourceId: string } | null>;
}
export interface PortfolioAuthorizationPort {
  /** Bound to a verified server principal/worker grant; checks ownership and revocation. */
  check(binding: Binding, context: IoContext): Promise<boolean>;
}
/** Server-only composition after authorization; the injected source has no mutation methods. */
export function createPortfolioAccount(options: {
  binding: Binding;
  authorization: PortfolioAuthorizationPort;
  store: PortfolioStore;
  registry: InstrumentRegistry;
  source: PortfolioReadSource;
  now: () => number;
  operationTimeoutMs?: number;
}) {
  if (
    Object.keys(options).some(
      (k) =>
        ![
          'binding',
          'authorization',
          'store',
          'registry',
          'source',
          'now',
          'operationTimeoutMs',
        ].includes(k),
    ) ||
    !options.store ||
    !options.authorization ||
    !options.registry ||
    !options.source ||
    typeof options.now !== 'function' ||
    !Number.isInteger(options.operationTimeoutMs ?? 3000) ||
    (options.operationTimeoutMs ?? 3000) < 1 ||
    (options.operationTimeoutMs ?? 3000) > 5000
  )
    throw new Error('INVALID_PORTFOLIO_OPTIONS');
  const binding = immutable(bindingSchema.parse(options.binding));
  const budget = options.operationTimeoutMs ?? 3000;
  let reconciled = false,
    closed = false,
    active = false;
  const operations = new Set<AbortController>();
  const settlements = new Set<Promise<void>>();
  async function operation<T>(
    work: (c: IoContext) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (closed || active) throw new Error('PORTFOLIO_BUSY');
    if (signal?.aborted) throw new Error('PORTFOLIO_ABORTED');
    active = true;
    const controller = new AbortController(),
      abort = () => controller.abort();
    operations.add(controller);
    let settle = () => {};
    const settlement = new Promise<void>((resolve) => {
      settle = resolve;
    });
    settlements.add(settlement);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, budget);
    try {
      const context = { signal: controller.signal, deadline: Date.now() + budget };
      if ((await options.authorization.check(binding, context)) !== true)
        throw new Error('PORTFOLIO_AUTHORIZATION_DENIED');
      if (context.signal.aborted) throw new Error('PORTFOLIO_ABORTED');
      return await work(context);
    } catch (error) {
      reconciled = false;
      const safe = new Set([
        'PORTFOLIO_AUTHORIZATION_DENIED',
        'PORTFOLIO_SCOPE_MISMATCH',
        'PORTFOLIO_ABORTED',
        'PORTFOLIO_STORE_FAILED',
        'EVIDENCE_CONFLICT',
        'REVISION_CONFLICT',
        'INCOMPLETE_COVERAGE',
        'RECONCILIATION_REPAIR_CONFLICT',
        'OUT_OF_ORDER_ECONOMIC',
        'POSITION_DIRECTION',
        'FUNDING_POSITION_SCOPE',
        'UNSUPPORTED_QUANTITY_UNIT',
        'UNPROVEN_FEE_CONVERSION',
      ]);
      const code =
        error instanceof Error &&
        (safe.has(error.message) || exchangeErrorCodeSchema.safeParse(error.message).success)
          ? error.message
          : 'PORTFOLIO_OPERATION_FAILED';
      // eslint-disable-next-line preserve-caught-error -- Raw source errors can contain private account data or credentials.
      throw new Error(code, { cause: new Error('PORTFOLIO_OPERATION_FAILED') });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      operations.delete(controller);
      settlements.delete(settlement);
      settle();
      active = false;
    }
  }
  function privateScope(account: Fill['account'], scope: Fill['scope']) {
    if (
      account.tenantId !== binding.tenantId ||
      account.connectionId !== binding.connectionId ||
      account.externalAccountId !== binding.externalAccountId ||
      !sameMarketScope(scope, binding.scope)
    )
      throw new Error('PORTFOLIO_SCOPE_MISMATCH');
  }
  const identity = (kind: string, scope: string, instrument: string, id: string) =>
    createHash('sha256')
      .update(canonical([kind, scope, instrument, id]))
      .digest('hex');
  return Object.freeze({
    binding,
    read(signal?: AbortSignal) {
      return operation(
        async (c) => ({
          checkpoint: await options.store.read(binding, c),
          reconciledAfterRestart: reconciled,
        }),
        signal,
      );
    },
    reconcile(signal?: AbortSignal) {
      return operation(async (c) => {
        const checkpoint = await options.store.read(binding, c);
        const pendingEvidence: PortfolioEvidence[] = [];
        for (let offset = 0; offset < checkpoint.state.pending.length; offset += 200)
          pendingEvidence.push(
            ...(await options.store.evidence(
              binding,
              checkpoint.state.pending.slice(offset, offset + 200),
              c,
            )),
          );
        if (pendingEvidence.length !== checkpoint.state.pending.length)
          throw new Error('MISSING_EVENT_EVIDENCE');
        const snapshot = await options.source.snapshot(
          binding,
          { ...checkpoint, pendingEvidence },
          c,
        );
        if (c.signal.aborted) throw new Error('PORTFOLIO_ABORTED');
        const result = await options.store.apply(binding, snapshot, checkpoint.revision, c);
        // An old identical response after restart is not new synchronization evidence.
        reconciled =
          (!result.duplicate || reconciled) && result.checkpoint.state.status === 'RECONCILED';
        return result;
      }, signal);
    },
    ingestFill(raw: unknown, signal?: AbortSignal) {
      return operation(async (c) => {
        const native = fillSchema.parse(raw);
        privateScope(native.account, native.scope);
        const execution = await options.source.executionContext(binding, native, c);
        const record = options.registry.get(binding.scope, native.instrumentId, options.now());
        if (!record.ok) throw new Error(record.error.code);
        const { instrument, rules } = record.value;
        if (
          execution.metadataVersion !== instrument.metadataVersion ||
          execution.ruleVersion !== rules.version
        )
          throw new Error('STALE_METADATA');
        const quantity =
          native.quantityUnit === 'BASE'
            ? native.quantity
            : instrument.contract?.unit === 'BASE'
              ? decimalMultiply(native.quantity, instrument.contract.size)
              : null;
        if (quantity === null) throw new Error('UNSUPPORTED_QUANTITY_UNIT');
        const fees: FillEvent['fees'] = [];
        for (const fee of native.fees) {
          if (fee.kind === 'FUNDING') throw new Error('INVALID_FILL_FEE');
          const fx =
            fee.asset === instrument.quoteAsset || fee.asset === instrument.baseAsset
              ? null
              : await options.source.feeFx(
                  binding,
                  fee.asset,
                  instrument.quoteAsset,
                  native.exchangeTime,
                  c,
                );
          const quoteEquivalent =
            fee.asset === instrument.quoteAsset
              ? fee.amount
              : fee.asset === instrument.baseAsset
                ? decimalMultiply(fee.amount, native.price)
                : fx
                  ? decimalMultiply(fee.amount, parseDecimal(fx.rate))
                  : null;
          fees.push({ ...fee, quoteEquivalent, ...(fx ? { fx } : {}) });
        }
        const event: FillEvent = {
          type: 'FILL',
          id: identity('FILL', native.identityScope, native.instrumentId, native.fillId),
          timestamp: native.exchangeTime,
          internalOrderId: native.internalOrderId,
          native: {
            fillId: native.fillId,
            identityScope: native.identityScope,
            exchangeOrderId: native.exchangeOrderId,
          },
          instrumentId: native.instrumentId,
          base: instrument.baseAsset,
          quote: instrument.quoteAsset,
          quantity,
          price: native.price,
          fees: fees.map(({ asset, amount, quoteEquivalent, fx }) => ({
            asset,
            amount,
            quoteEquivalent,
            ...(fx ? { fx } : {}),
          })),
          ...execution,
        };
        const checkpoint = await options.store.read(binding, c);
        if (c.signal.aborted) throw new Error('PORTFOLIO_ABORTED');
        const current = options.registry.get(binding.scope, native.instrumentId, options.now());
        if (
          !current.ok ||
          current.value.instrument.metadataVersion !== instrument.metadataVersion ||
          current.value.rules.version !== rules.version
        )
          throw new Error('STALE_METADATA');
        return options.store.apply(binding, event, checkpoint.revision, c);
      }, signal);
    },
    ingestFunding(raw: unknown, positionKey: string, signal?: AbortSignal) {
      return operation(async (c) => {
        const native: Funding = fundingSchema.parse(raw);
        privateScope(native.account, native.scope);
        const checkpoint = await options.store.read(binding, c);
        const position = checkpoint.state.positions.find(
          (p) => JSON.stringify([p.instrumentId, p.positionSide, p.bucket]) === positionKey,
        );
        if (position?.instrumentId !== native.instrumentId)
          throw new Error('FUNDING_POSITION_SCOPE');
        return options.store.apply(
          binding,
          {
            type: 'FUNDING',
            native: { fundingId: native.fundingId, identityScope: native.identityScope },
            id: identity('FUNDING', native.identityScope, native.instrumentId, native.fundingId),
            timestamp: native.timestamp,
            asset: native.asset,
            amount: native.amount,
            positionKey,
          },
          checkpoint.revision,
          c,
        );
      }, signal);
    },
    async close() {
      closed = true;
      reconciled = false;
      for (const controller of operations) controller.abort();
      await Promise.allSettled([...settlements]);
    },
  });
}
