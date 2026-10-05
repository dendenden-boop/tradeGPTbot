import { randomUUID } from 'node:crypto';
import {
  computeCommandHash,
  immutable,
  sameMarketScope,
  validateOrderAgainstRules,
  mutationOutcomeSchema,
  type ExchangeAdapter,
  type Fill,
  type InstrumentRegistry,
  type RequestContext,
} from '@ctp/exchange-core';
import {
  bindingSchema,
  draftSchema,
  grantSchema,
  hash,
  type OrderBinding,
  type OrderDraft,
  type OrderState,
  type RiskGrant,
  type OrderStore,
  type IoContext,
  type DispatchClaim,
} from './domain.js';
export interface OrderAuthorizationPort {
  check(
    binding: OrderBinding,
    action: 'CREATE' | 'READ' | 'SUBMIT' | 'CANCEL' | 'RECONCILE',
    context: IoContext,
  ): Promise<boolean>;
}
export interface OrderRiskPort {
  approve(
    input: {
      binding: OrderBinding;
      state: OrderState;
      intentId: string;
      operation: 'PLACE' | 'CANCEL';
      commandHash: string;
    },
    context: IoContext,
  ): Promise<RiskGrant>;
}
export interface PortfolioFillPort {
  ingest(
    input: { binding: OrderBinding; state: OrderState; fill: Fill },
    context: IoContext,
  ): Promise<{ bookId: string; eventId: string }>;
}
/** Server-only composition. No authority is inferred from a binding, mode or port's shape. */
export function createOrderEngine(options: {
  binding: OrderBinding;
  authorization: OrderAuthorizationPort;
  risk: OrderRiskPort;
  fills: PortfolioFillPort;
  registry: InstrumentRegistry;
  store: OrderStore;
  adapter: ExchangeAdapter;
  now: () => number;
  operationTimeoutMs?: number;
}) {
  if (
    Object.keys(options).some(
      (k) =>
        ![
          'binding',
          'authorization',
          'risk',
          'fills',
          'registry',
          'store',
          'adapter',
          'now',
          'operationTimeoutMs',
        ].includes(k),
    ) ||
    !options.authorization ||
    !options.risk ||
    !options.fills ||
    !options.registry ||
    !options.store ||
    !options.adapter ||
    typeof options.now !== 'function' ||
    !Number.isInteger(options.operationTimeoutMs ?? 3000) ||
    (options.operationTimeoutMs ?? 3000) < 1 ||
    (options.operationTimeoutMs ?? 3000) > 5000
  )
    throw new Error('ORDER_OPTIONS');
  const b = immutable(bindingSchema.parse(options.binding)),
    budget = options.operationTimeoutMs ?? 3000,
    account =
      b.connectionId === null
        ? null
        : {
            tenantId: b.tenantId,
            connectionId: b.connectionId,
            externalAccountId: b.externalAccountId,
          };
  if (
    hash(options.adapter.profile) !== hash(b.profile) ||
    hash(options.adapter.account) !== hash(account)
  )
    throw new Error('ORDER_SCOPE');
  const active = new Set<AbortController>(),
    settlements = new Set<Promise<void>>();
  let closed = false;
  const context = (c: IoContext): RequestContext => ({
    ...c,
    profile: b.profile,
    account,
    correlationId: randomUUID(),
  });
  const check = (c: IoContext) => {
    if (c.signal.aborted || Date.now() >= c.deadline) throw new Error('ORDER_ABORTED');
  };
  function metadata(d: OrderDraft, cancelVersion?: string) {
    const scope = {
      exchange: b.profile.exchange,
      region: b.profile.region,
      environment: b.profile.environment,
      market: b.profile.market,
    };
    const r = options.registry.get(scope, d.order.instrumentId, options.now());
    if (!r.ok) throw new Error('ORDER_METADATA');
    if (
      cancelVersion === undefined
        ? !validateOrderAgainstRules(
            { ...d.order, clientOrderId: 'server' },
            r.value,
            options.now(),
          ).ok
        : r.value.rules.version !== cancelVersion
    )
      throw new Error('ORDER_METADATA');
    return hash(r.value);
  }
  async function auth(action: 'CREATE' | 'READ' | 'SUBMIT' | 'CANCEL' | 'RECONCILE', c: IoContext) {
    if ((await options.authorization.check(b, action, c)) !== true)
      throw new Error('ORDER_AUTHORIZATION_DENIED');
    check(c);
  }
  async function operation<T>(
    action: 'CREATE' | 'READ' | 'SUBMIT' | 'CANCEL' | 'RECONCILE',
    work: (c: IoContext) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (closed) throw new Error('ORDER_CLOSED');
    if (active.size >= 32) throw new Error('ORDER_BUSY');
    if (signal?.aborted) throw new Error('ORDER_ABORTED');
    const controller = new AbortController(),
      abort = () => controller.abort();
    active.add(controller);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, budget);
    let settle = () => {};
    const settlement = new Promise<void>((r) => {
      settle = r;
    });
    settlements.add(settlement);
    try {
      const c = { signal: controller.signal, deadline: Date.now() + budget };
      await auth(action, c);
      return await work(c);
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Injected ports can contain private account data or credentials in their errors.
      throw new Error(safeCode(error), { cause: new Error('ORDER_OPERATION_FAILED') });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      active.delete(controller);
      settlements.delete(settlement);
      settle();
    }
  }
  function mode() {
    if (b.mode === 'LIVE') throw new Error('ORDER_LIVE_DISABLED');
    if (b.mode === 'PAPER') throw new Error('ORDER_PAPER_ENGINE_REQUIRED');
  }
  async function send(claim: DispatchClaim, c: IoContext): Promise<OrderState> {
    let outcome,
      dispatched = false;
    try {
      await auth(claim.operation === 'PLACE' ? 'SUBMIT' : 'CANCEL', c);
      check(c);
      const authorization = {
        commandId: claim.intentId,
        commandHash: claim.commandHash,
        dispatchAttemptId: claim.attemptId,
        profile: b.profile,
        account: account!,
        issuedAt: options.now(),
        expiresAt: Math.min(claim.expiresAt, c.deadline),
      };
      dispatched = true;
      outcome = mutationOutcomeSchema.parse(
        claim.operation === 'PLACE'
          ? await options.adapter.createOrder(
              { authorization, command: claim.state.command },
              context(c),
            )
          : await options.adapter.cancelOrder(
              {
                authorization,
                command: {
                  instrumentId: claim.state.command.instrumentId,
                  locator: { kind: 'CLIENT_ID', id: claim.state.command.clientOrderId },
                },
              },
              context(c),
            ),
      );
    } catch {
      outcome = dispatched
        ? { kind: 'UNKNOWN' as const, error: { code: 'UNAVAILABLE' as const } }
        : {
            kind: 'DEFINITIVELY_REJECTED' as const,
            error: { code: 'AUTHORIZATION_REQUIRED' as const },
          };
    }
    // Persist uncertainty even after caller cancellation; this finite cleanup remains owned.
    return options.store.result(b, claim, outcome, {
      signal: new AbortController().signal,
      deadline: Date.now() + 3000,
    });
  }
  async function dispatch(
    id: string,
    intentId: string,
    fp: string,
    op: 'PLACE' | 'CANCEL',
    c: IoContext,
    cancelVersion?: string,
  ) {
    mode();
    const s = await options.store.read(b, id, c);
    const initial = metadata(s.draft, cancelVersion);
    const grant = grantSchema.parse(
      await options.risk.approve(
        { binding: b, state: s, intentId, operation: op, commandHash: fp },
        c,
      ),
    );
    await auth(op === 'PLACE' ? 'SUBMIT' : 'CANCEL', c);
    if (initial !== metadata(s.draft, cancelVersion)) throw new Error('ORDER_METADATA');
    check(c);
    const claim = await options.store.begin(b, id, intentId, grant, c);
    if (claim === null) return options.store.read(b, id, c);
    // Adapter authorization and its repeated rules guards protect the final dispatch boundary.
    return send(claim, c);
  }
  return Object.freeze({
    create(raw: OrderDraft, signal?: AbortSignal) {
      return operation(
        'CREATE',
        async (c) => {
          const d = draftSchema.parse(raw);
          metadata(d);
          check(c);
          return options.store.create(b, d, c);
        },
        signal,
      );
    },
    get(id: string, signal?: AbortSignal) {
      return operation('READ', (c) => options.store.read(b, id, c), signal);
    },
    submit(id: string, signal?: AbortSignal) {
      return operation(
        'SUBMIT',
        async (c) => {
          mode();
          const s = await options.store.read(b, id, c);
          if (s.status !== 'CREATED') return s;
          const fp = computeCommandHash('createOrder', s.command, { profile: b.profile, account });
          return dispatch(id, s.intentId, fp, 'PLACE', c);
        },
        signal,
      );
    },
    cancel(id: string, key: string, signal?: AbortSignal) {
      return operation(
        'CANCEL',
        async (c) => {
          mode();
          const cmd = await options.store.cancelIntent(b, id, key, c);
          if (cmd.dispatched) return cmd.state;
          return dispatch(id, cmd.intentId, cmd.commandHash, 'CANCEL', c, cmd.ruleVersion);
        },
        signal,
      );
    },
    reconcile(id: string, signal?: AbortSignal) {
      return operation(
        'RECONCILE',
        async (c) => {
          mode();
          let s = await options.store.read(b, id, c);
          const lookup = () =>
            options.adapter.getOrder(
              {
                instrumentId: s.command.instrumentId,
                locator: { kind: 'CLIENT_ID', id: s.command.clientOrderId },
              },
              context(c),
            );
          try {
            const found = await lookup();
            check(c);
            if (!found.ok || found.value.kind !== 'FOUND') return await options.store.gap(b, id, c);
            if (found.value.order.updatedAt > options.now())
              throw new Error('ORDER_HISTORY_REQUIRED');
            s = await options.store.observe(b, id, found.value.order, c);
            const queryId = randomUUID(),
              to = options.now() + 1;
            let cursor: string | null = null;
            const cursors = new Set<string>();
            for (let page = 0; page < 10; page++) {
              const result = await options.adapter.getTrades(
                {
                  instrumentId: s.command.instrumentId,
                  from: s.createdAt,
                  to,
                  limit: 200,
                  cursor,
                  queryId,
                },
                context(c),
              );
              check(c);
              if (!result.ok || result.value.queryId !== queryId)
                throw new Error('ORDER_HISTORY_REQUIRED');
              for (const fill of result.value.items) {
                if (fill.exchangeOrderId !== s.exchangeOrderId) continue;
                if (
                  !sameMarketScope(fill.scope, b.profile) ||
                  hash(fill.account) !== hash(account) ||
                  fill.instrumentId !== s.command.instrumentId ||
                  fill.quantityUnit !== 'BASE'
                )
                  throw new Error('ORDER_SCOPE');
                const proof = await options.fills.ingest({ binding: b, state: s, fill }, c);
                check(c);
                s = await options.store.adopt(b, id, proof.bookId, proof.eventId, c);
              }
              cursor = result.value.nextCursor;
              if (cursor === null) break;
              if (cursors.has(cursor) || page === 9) throw new Error('ORDER_HISTORY_REQUIRED');
              cursors.add(cursor);
            }
            const final = await lookup();
            check(c);
            if (
              !final.ok ||
              final.value.kind !== 'FOUND' ||
              final.value.order.updatedAt > options.now() ||
              final.value.order.filledQuantity !== s.executedQuantity
            )
              throw new Error('ORDER_HISTORY_REQUIRED');
            await auth('RECONCILE', c);
            s = await options.store.complete(b, id, final.value.order, c);
            if (s.reconciliation !== 'CONSISTENT') throw new Error('ORDER_HISTORY_REQUIRED');
            return s;
          } catch (error) {
            await options.store.gap(b, id, {
              signal: new AbortController().signal,
              deadline: Date.now() + 3000,
            });
            // eslint-disable-next-line preserve-caught-error -- Port exceptions must not expose raw native payloads or secrets.
            throw new Error(safeCode(error), { cause: new Error('ORDER_RECONCILIATION_FAILED') });
          }
        },
        signal,
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const c of active) c.abort();
      await Promise.all([...settlements]);
    },
  });
}
const safe = new Set([
  'ORDER_OPTIONS',
  'ORDER_SCOPE',
  'ORDER_METADATA',
  'ORDER_AUTHORIZATION_DENIED',
  'ORDER_ABORTED',
  'ORDER_BUSY',
  'ORDER_CLOSED',
  'ORDER_LIVE_DISABLED',
  'ORDER_PAPER_ENGINE_REQUIRED',
  'ORDER_BINDING_DENIED',
  'ORDER_IDEMPOTENCY_CONFLICT',
  'ORDER_RISK_DENIED',
  'ORDER_RECONCILIATION_REQUIRED',
  'ORDER_TRANSITION',
  'ORDER_OBSERVATION_CONFLICT',
  'ORDER_TERMINAL',
  'ORDER_FILL_BOUND',
  'ORDER_FILL_PROOF',
  'ORDER_EVIDENCE_CONFLICT',
  'ORDER_STORE_FAILED',
  'ORDER_HISTORY_REQUIRED',
  'ORDER_EXECUTION_PRICE_REQUIRED',
  'ORDER_ID_EXHAUSTED',
]);
function safeCode(e: unknown) {
  return e instanceof Error && safe.has(e.message) ? e.message : 'ORDER_STORE_FAILED';
}
