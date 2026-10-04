import { randomUUID } from 'node:crypto';
import {
  accountInfoSchema,
  immutable,
  type ReadOperation,
  type MutationOperation,
  type RequestContext,
  type InstrumentRecord,
} from '@ctp/exchange-core';
import { HtxProtocolError, readResponse, type HtxResponse } from './client.js';
import type { HtxEndpointProfile } from './profiles.js';
import type { HtxBinding, HtxSigner } from './auth.js';
import type { HtxIdentityPort } from './ports.js';
import type { PublicTransport } from './public-transport.js';
import {
  normalizeWallet,
  normalizeOrder,
  normalizePosition,
  normalizeFill,
} from './private-data.js';
import {
  wireObject as object,
  wireArray as array,
  wireInteger as integer,
  wireId as id,
} from './wire.js';
export function createPrivateTransport(
  endpoint: HtxEndpointProfile,
  binding: HtxBinding | null,
  signer: HtxSigner,
  pub: PublicTransport,
  identities: HtxIdentityPort | undefined,
  syncTime: (context: RequestContext) => Promise<void>,
  now: () => number,
) {
  const snapshots = new Map<
      string,
      {
        readonly query: string;
        readonly rows: readonly unknown[];
        readonly expiresAt: number;
        readonly record: InstrumentRecord;
        offset: number;
      }
    >(),
    consuming = new Set<string>();
  let pendingSnapshots = 0;
  const account = () => {
    if (!binding) throw new HtxProtocolError('AUTHORIZATION_REQUIRED');
    return binding.account;
  };
  async function call(
    path: string,
    context: RequestContext,
    params?: Readonly<Record<string, string>>,
    body?: Readonly<Record<string, string | number>>,
    identity = false,
  ): Promise<HtxResponse> {
    account();
    return pub.client.call(
      {
        path,
        sign: signer.rest,
        ...(params === undefined ? {} : { params }),
        ...(body === undefined ? {} : { body }),
        ...(identity ? { identity: true } : {}),
      },
      context,
    );
  }
  async function accountEvidence(context: RequestContext) {
    await syncTime(context);
    const proof = await signer.permission(context),
      uid = await call('/v2/user/uid', context, undefined, undefined, true);
    if (id(readResponse(uid)) !== account().externalAccountId)
      throw new HtxProtocolError('SCOPE_MISMATCH');
    let wallet: HtxResponse | undefined;
    if (endpoint.spot) {
      const r = await call('/v1/account/accounts', context),
        all = array(readResponse(r), 100);
      const selected = all.map(object).filter((x) => id(x.id) === binding!.spotAccountId);
      if (selected.length !== 1 || selected[0]!.type !== 'spot' || selected[0]!.state !== 'working')
        throw new HtxProtocolError('AUTHORIZATION_REQUIRED');
    } else {
      const type = await call('/linear-swap-api/v3/swap_unified_account_type', context),
        config = object(readResponse(type));
      if (Object.keys(config).length !== 1 || integer(config.account_type) !== 1)
        throw new HtxProtocolError('UNSUPPORTED');
      wallet = await call('/linear-swap-api/v1/swap_cross_account_info', context, undefined, {
        margin_account: 'USDT',
      });
      const w = normalizeWallet(
        readResponse(wallet),
        account(),
        endpoint.scope,
        integer(wallet.raw.ts),
        wallet.receivedAt,
      );
      if (w.freshness !== 'FRESH') throw new HtxProtocolError('STALE_METADATA');
    }
    if (now() >= proof.expiresAt || now() - proof.checkedAt > 30000)
      throw new HtxProtocolError('AUTHORIZATION_REQUIRED');
    return {
      wallet,
      info: immutable(
        accountInfoSchema.parse({
          account: account(),
          scope: endpoint.scope,
          accountMode: endpoint.spot ? 'SPOT_CASH' : 'SINGLE_ASSET_CROSS_HEDGE',
          permissions: proof.canTrade ? ['READ', 'TRADE'] : ['READ'],
          positionMode: endpoint.spot ? 'NOT_APPLICABLE' : 'HEDGE',
          checkedAt: now(),
        }),
      ),
    };
  }
  function normalizedOrder(raw: unknown, r: InstrumentRecord, receivedAt: number) {
    if (!identities) throw new HtxProtocolError('AUTHORIZATION_REQUIRED');
    const x = object(raw);
    const exchangeId = id(endpoint.spot ? x.id : (x.order_id_str ?? x.order_id)),
      client = id(endpoint.spot ? x['client-order-id'] : x.client_order_id);
    return normalizeOrder(
      raw,
      r,
      account(),
      identities.order(account(), r.instrument.id, exchangeId, client),
      receivedAt,
      binding?.spotAccountId,
    );
  }
  async function lookup(
    instrumentId: string,
    locator: { readonly kind: string; readonly id: string },
    context: RequestContext,
  ) {
    const r = pub.record(instrumentId);
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(locator.id) ||
      (!endpoint.spot && !/^\d{1,19}$/.test(locator.id))
    )
      throw new HtxProtocolError('INVALID_REQUEST');
    let response: HtxResponse;
    try {
      response = endpoint.spot
        ? await call(
            locator.kind === 'CLIENT_ID'
              ? '/v1/order/orders/getClientOrder'
              : `/v1/order/orders/${locator.id}`,
            context,
            locator.kind === 'CLIENT_ID' ? { clientOrderId: locator.id } : undefined,
          )
        : await call('/linear-swap-api/v1/swap_cross_order_info', context, undefined, {
            contract_code: r.instrument.id,
            [locator.kind === 'CLIENT_ID' ? 'client_order_id' : 'order_id']: locator.id,
          });
    } catch (e) {
      if (e instanceof HtxProtocolError && e.code === 'UNAVAILABLE')
        return { kind: 'INDETERMINATE', reason: 'NOT_AUTHORITATIVE' };
      throw e;
    }
    pub.assertRecord(r);
    const raw = readResponse(response),
      rows = endpoint.spot ? (raw === null ? [] : [raw]) : array(raw, 1);
    if (rows.length === 0) return { kind: 'INDETERMINATE', reason: 'NOT_AUTHORITATIVE' };
    if (rows.length !== 1) throw new HtxProtocolError('INVALID_RESPONSE');
    const order = normalizedOrder(rows[0], r, response.receivedAt);
    if ((locator.kind === 'CLIENT_ID' ? order.clientOrderId : order.exchangeOrderId) !== locator.id)
      throw new HtxProtocolError('SCOPE_MISMATCH');
    return { kind: 'FOUND', order };
  }
  async function readRows(
    operation: string,
    input: Record<string, unknown>,
    r: InstrumentRecord,
    context: RequestContext,
  ): Promise<readonly unknown[]> {
    if (operation === 'getPositions') {
      if (endpoint.spot) throw new HtxProtocolError('UNSUPPORTED');
      const response = await call(
        '/linear-swap-api/v1/swap_cross_position_info',
        context,
        undefined,
        { contract_code: r.instrument.id },
      );
      pub.assertRecord(r);
      const observedAt = integer(response.raw.ts);
      if (observedAt > response.receivedAt + 1000 || response.receivedAt - observedAt > 5000)
        throw new HtxProtocolError('INVALID_RESPONSE');
      return array(readResponse(response), 2).map((x) =>
        normalizePosition(x, r, account(), observedAt),
      );
    }
    if (operation === 'getOpenOrders') {
      if (endpoint.spot) {
        const response = await call('/v1/order/openOrders', context, {
          symbol: r.instrument.id,
          'account-id': binding!.spotAccountId!,
          size: '500',
        });
        pub.assertRecord(r);
        const rows = array(readResponse(response), 500);
        if (rows.length === 500) throw new HtxProtocolError('UNSUPPORTED');
        return rows.map((x) => normalizedOrder(x, r, response.receivedAt));
      }
      const collected: unknown[] = [];
      let total: number | undefined;
      for (let page = 1; page <= 40; page++) {
        const response = await call(
            '/linear-swap-api/v1/swap_cross_openorders',
            context,
            undefined,
            {
              contract_code: r.instrument.id,
              page_index: page,
              page_size: 50,
              sort_by: 'created_at',
            },
          ),
          data = object(readResponse(response));
        pub.assertRecord(r);
        const pages = integer(data.total_page),
          size = integer(data.total_size);
        if (pages > 40 || size > 2000) throw new HtxProtocolError('UNSUPPORTED');
        if (integer(data.current_page) !== page || (total !== undefined && total !== size))
          throw new HtxProtocolError('INVALID_RESPONSE');
        total = size;
        collected.push(
          ...array(data.orders, 50).map((x) => normalizedOrder(x, r, response.receivedAt)),
        );
        if (page >= pages) {
          if (collected.length !== size) throw new HtxProtocolError('INVALID_RESPONSE');
          return collected;
        }
      }
      throw new HtxProtocolError('UNSUPPORTED');
    }
    const from = integer(input.from),
      to = integer(input.to);
    if (from > to || to > now() || to - from > 172800000 || from < now() - 90 * 86400000)
      throw new HtxProtocolError('UNSUPPORTED');
    if (from === to) return [];
    const collected: unknown[] = [];
    let cursor: string | undefined;
    // Walk native cursor to an empty page. Native short pages are not fabricated end-of-history.
    for (let page = 0; page < 40; page++) {
      const trades = operation === 'getTrades';
      const response = endpoint.spot
        ? await call(trades ? '/v1/order/matchresults' : '/v1/order/orders', context, {
            symbol: r.instrument.id,
            'start-time': String(from),
            'end-time': String(to),
            direct: 'next',
            size: '500',
            ...(trades
              ? {}
              : { states: 'submitted,partial-filled,partial-canceled,filled,canceled' }),
            ...(cursor === undefined ? {} : { from: cursor }),
          })
        : await call(
            trades
              ? '/linear-swap-api/v3/swap_cross_matchresults'
              : '/linear-swap-api/v3/swap_cross_hisorders',
            context,
            undefined,
            {
              contract: r.instrument.id,
              trade_type: 0,
              start_time: from,
              end_time: to,
              direct: 'next',
              ...(trades ? {} : { type: 1, status: '0' }),
              ...(cursor === undefined ? {} : { from_id: cursor }),
            },
          );
      pub.assertRecord(r);
      const rows = array(readResponse(response), 2000);
      if (rows.length === 0) return collected;
      let next = cursor;
      for (const raw of rows) {
        const x = object(raw),
          rowCursor = id(endpoint.spot ? x.id : x.query_id);
        if (
          !/^\d{1,30}$/.test(rowCursor) ||
          (next !== undefined && BigInt(rowCursor) <= BigInt(next))
        )
          throw new HtxProtocolError('INVALID_RESPONSE');
        next = rowCursor;
        if (collected.length >= 2000) throw new HtxProtocolError('UNSUPPORTED');
        if (trades) {
          if (!identities) throw new HtxProtocolError('AUTHORIZATION_REQUIRED');
          const exchangeId = id(endpoint.spot ? x['order-id'] : (x.order_id_str ?? x.order_id));
          collected.push(
            normalizeFill(
              raw,
              r,
              account(),
              identities.fill(account(), r.instrument.id, exchangeId),
              response.receivedAt,
            ),
          );
        } else collected.push(normalizedOrder(raw, r, response.receivedAt));
      }
      if (next === cursor) throw new HtxProtocolError('INVALID_RESPONSE');
      cursor = next;
    }
    throw new HtxProtocolError('UNSUPPORTED');
  }
  function prune() {
    for (const [key, s] of snapshots) if (s.expiresAt <= now()) snapshots.delete(key);
  }
  async function paginated(
    operation: string,
    input: Record<string, unknown>,
    context: RequestContext,
  ) {
    const r = pub.record(input.instrumentId),
      query = JSON.stringify({ ...input, cursor: null, operation }),
      limit = integer(input.limit);
    prune();
    if (input.cursor !== null) {
      const key = id(input.cursor),
        s = snapshots.get(key);
      if (!s || s.query !== query) throw new HtxProtocolError('INVALID_REQUEST');
      if (consuming.has(key)) throw new HtxProtocolError('BUSY');
      consuming.add(key);
      try {
        pub.assertRecord(s.record);
        const end = s.offset + limit,
          items = s.rows.slice(s.offset, end);
        snapshots.delete(key);
        let nextCursor: string | null = null;
        if (end < s.rows.length) {
          nextCursor = randomUUID();
          snapshots.set(nextCursor, { ...s, offset: end });
        }
        return { items, nextCursor, queryId: input.queryId };
      } finally {
        consuming.delete(key);
      }
    }
    if (snapshots.size + pendingSnapshots >= 16) throw new HtxProtocolError('BUSY');
    pendingSnapshots++;
    try {
      const rows = immutable(await readRows(operation, input, r, context));
      pub.assertRecord(r);
      const identities = rows.map((row) => {
        const x = object(row);
        return String(x.fillId ?? x.exchangeOrderId ?? x.side);
      });
      if (new Set(identities).size !== identities.length)
        throw new HtxProtocolError('INVALID_RESPONSE');
      if (rows.length <= limit) return { items: rows, nextCursor: null, queryId: input.queryId };
      const key = randomUUID();
      snapshots.set(key, {
        query,
        rows,
        offset: limit,
        expiresAt: Math.min(now() + 30000, r.rules.expiresAt),
        record: r,
      });
      return { items: rows.slice(0, limit), nextCursor: key, queryId: input.queryId };
    } finally {
      pendingSnapshots--;
    }
  }
  return Object.freeze({
    accountEvidence,
    lookup,
    spotAccountId: binding?.spotAccountId,
    async request(
      operation: ReadOperation | MutationOperation,
      raw: unknown,
      context: RequestContext,
    ): Promise<unknown> {
      const input = object(raw);
      if (
        ![
          'testConnection',
          'getAccountInfo',
          'getBalances',
          'getPositions',
          'getOpenOrders',
          'getOrder',
          'getOrderHistory',
          'getTrades',
        ].includes(operation)
      )
        throw new HtxProtocolError('UNSUPPORTED');
      const evidence = await accountEvidence(context);
      if (operation === 'testConnection')
        return {
          authenticated: true,
          canRead: true,
          canTrade: false,
          checkedAt: evidence.info.checkedAt,
        };
      if (operation === 'getAccountInfo') return evidence.info;
      if (operation === 'getBalances') {
        const response =
          evidence.wallet ??
          (await call(`/v1/account/accounts/${binding!.spotAccountId!}/balance`, context));
        return normalizeWallet(
          readResponse(response),
          account(),
          endpoint.scope,
          endpoint.spot ? response.receivedAt : integer(response.raw.ts),
          response.receivedAt,
          binding?.spotAccountId,
        );
      }
      if (operation === 'getOrder') {
        const locator = object(input.locator);
        return lookup(
          String(input.instrumentId),
          { kind: String(locator.kind), id: id(locator.id) },
          context,
        );
      }
      return paginated(operation, input, context);
    },
  });
}
export type PrivateTransport = ReturnType<typeof createPrivateTransport>;
