import { createHash, randomUUID } from 'node:crypto';
import {
  accountScopeSchema,
  assetSchema,
  errorCodeSchema,
  immutable,
  isStepAligned,
  operations,
  parseDecimal,
  sameMarketScope,
  timestampSchema,
  validateOrderAgainstRules,
} from '@ctp/exchange-core';
import type {
  AccountSnapshot,
  ExchangeErrorCode,
  InstrumentRecord,
  MutationOperation,
  MutationOutcome,
  NewOrder,
  ReadOperation,
  RequestContext,
} from '@ctp/exchange-core';
import type { BinanceBinding, BinanceSigner } from './auth.js';
import { assertActive, BinanceProtocolError, boundedPort, readResponse } from './client.js';
import type { BinanceRestClient, RestSpec } from './client.js';
import type { BinanceEndpointProfile } from './profiles.js';
import type { BinanceIdentityPort, BinanceOrderAdmissionPort } from './ports.js';
import type { BinanceAdmission } from './public-data.js';
import {
  normalizeFill,
  normalizeFuturesAccountInfo,
  normalizeFuturesBalances,
  normalizeOrder,
  normalizePositionV2,
  normalizeSpotAccount,
  normalizeSpotAccountInfo,
  serializeOrder,
  serializeOrderLocator,
} from './private-data.js';
import { wireArray, wireId, wireInteger, wireObject } from './wire.js';

export interface BinancePrivateTransportOptions {
  readonly endpoint: BinanceEndpointProfile;
  readonly binding: BinanceBinding | null;
  readonly signer: BinanceSigner;
  readonly client: BinanceRestClient;
  readonly record: (instrumentId: string) => InstrumentRecord;
  readonly admission: (instrumentId: string) => BinanceAdmission;
  readonly identities?: BinanceIdentityPort;
  readonly orderAdmission?: BinanceOrderAdmissionPort;
  readonly now: () => number;
  readonly syncTime: (context: RequestContext) => Promise<void>;
}

const SNAPSHOT_TTL = 300_000;
const SNAPSHOT_CAPACITY = 16;
const RESPONSE_LIMIT = 1000;
// These documented exchange errors mean the submitted parameters/key were
// rejected before order execution. Generic -2010 may be a duplicate client ID
// from a prior UNKNOWN attempt; it deliberately requires reconciliation.
const parameterRejections = new Set([
  '-1013',
  '-1021',
  '-1022',
  '-1100',
  '-1101',
  '-1102',
  '-1103',
  '-1104',
  '-1105',
  '-1106',
  '-1111',
  '-1112',
  '-1114',
  '-1115',
  '-1116',
  '-1117',
  '-1118',
  '-1119',
  '-1120',
  '-1121',
  '-1125',
  '-1128',
  '-1130',
  '-2014',
  '-2015',
]);
const rejected = (code: ExchangeErrorCode): MutationOutcome =>
  immutable({ kind: 'DEFINITIVELY_REJECTED', error: { code } });
const unknown = (code: ExchangeErrorCode = 'UNKNOWN_OUTCOME'): MutationOutcome =>
  immutable({ kind: 'UNKNOWN', error: { code } });
const invalidResponse = (): never => {
  throw new BinanceProtocolError('INVALID_RESPONSE');
};
const invalidRequest = (): never => {
  throw new BinanceProtocolError('INVALID_REQUEST');
};
function safeCode(failure: unknown): ExchangeErrorCode {
  if (failure instanceof Error && failure.message === 'INVALID_BINANCE_RESPONSE')
    return 'INVALID_RESPONSE';
  const raw =
    failure !== null && typeof failure === 'object' && 'code' in failure
      ? failure.code
      : failure instanceof Error
        ? failure.message
        : undefined;
  const result = errorCodeSchema.safeParse(raw);
  return result.success ? result.data : 'UNAVAILABLE';
}
function readError(failure: unknown): Error {
  const code = safeCode(failure);
  return immutable(Object.assign(new Error(code), { code }));
}
function numericId(raw: unknown): string {
  const value = wireId(raw);
  if (!/^(?:0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n)
    return invalidResponse();
  return value;
}
function numericCompare(a: string, b: string): number {
  const x = BigInt(a),
    y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
interface Snapshot {
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly items: readonly unknown[];
}

/** Private REST only. The outer Exchange Core enforces durable authorization and sandbox acceptance. */
export function createPrivateTransport(options: BinancePrivateTransportOptions) {
  const {
    endpoint,
    binding,
    signer,
    client,
    record,
    admission,
    identities,
    orderAdmission,
    now,
    syncTime,
  } = options;
  const spot = endpoint.scope.market === 'SPOT';
  const prefix = spot ? '/api/v3/' : '/fapi/v1/';
  const snapshots = new Map<string, Snapshot>();
  const authority = (context: RequestContext) => {
    assertActive(context, now);
    if (binding === null) throw new BinanceProtocolError('AUTHORIZATION_REQUIRED');
    const account = accountScopeSchema.safeParse(context.account);
    if (
      binding.profileId !== endpoint.id ||
      !sameMarketScope(context.profile, endpoint.scope) ||
      context.profile.endpointProfileId !== endpoint.id ||
      context.profile.accountMode !== endpoint.accountMode ||
      context.profile.credentialRef !== binding.credentialRef ||
      !account.success ||
      account.data.tenantId !== binding.account.tenantId ||
      account.data.connectionId !== binding.account.connectionId ||
      account.data.externalAccountId !== binding.account.externalAccountId
    )
      throw new BinanceProtocolError('SCOPE_MISMATCH');
    return binding.account;
  };
  const signed = async (spec: RestSpec, context: RequestContext) => {
    authority(context);
    await boundedPort(() => syncTime(context), context, now);
    return client.call(
      { ...spec, prepare: (signingContext) => signer.signRest(spec.params ?? {}, signingContext) },
      context,
    );
  };
  const accountInfo = async (context: RequestContext) => {
    const account = authority(context);
    const response = await signed(
      { path: spot ? '/api/v3/account' : '/fapi/v2/account', weight: spot ? 20 : 5 },
      context,
    );
    const data = readResponse(response);
    if (spot) return normalizeSpotAccountInfo(data, endpoint.scope, account, response.receivedAt);
    const mode = await signed({ path: '/fapi/v1/positionSide/dual', weight: 30 }, context);
    return normalizeFuturesAccountInfo(
      data,
      wireObject(readResponse(mode)).dualSidePosition,
      endpoint.scope,
      account,
      mode.receivedAt,
    );
  };
  const metadata = (instrumentId: unknown) => {
    if (typeof instrumentId !== 'string') return invalidRequest();
    const value = record(instrumentId);
    if (
      !sameMarketScope(value.instrument.scope, endpoint.scope) ||
      value.instrument.id !== instrumentId
    )
      throw new BinanceProtocolError('SCOPE_MISMATCH');
    return value;
  };
  const requireIdentities = () => {
    if (!identities) throw new BinanceProtocolError('AUTHORIZATION_REQUIRED');
    return identities;
  };
  function fingerprint(operation: string, input: Record<string, unknown>): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          operation,
          endpoint: endpoint.id,
          account: binding?.account,
          query: { ...input, cursor: null },
        }),
      )
      .digest('hex');
  }
  function page(operation: string, input: Record<string, unknown>, items?: readonly unknown[]) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 200
    )
      return invalidRequest();
    const hash = fingerprint(operation, input);
    let snapshot: Snapshot,
      token: string,
      offset = 0;
    if (input.cursor !== null) {
      if (typeof input.cursor !== 'string' || !/^[a-f0-9-]{36}\.\d{1,3}$/.test(input.cursor))
        return invalidRequest();
      const parts = input.cursor.split('.');
      token = parts[0]!;
      offset = Number(parts[1]);
      const found = snapshots.get(token);
      if (!found || found.fingerprint !== hash || offset < 1 || offset >= found.items.length)
        return invalidRequest();
      if (now() >= found.expiresAt) {
        snapshots.delete(token);
        throw new BinanceProtocolError('STALE_METADATA');
      }
      snapshot = found;
    } else {
      if (!items) return invalidRequest();
      if (items.length <= input.limit) return { items, nextCursor: null, queryId: input.queryId };
      for (const [key, value] of snapshots) if (now() >= value.expiresAt) snapshots.delete(key);
      if (snapshots.size >= SNAPSHOT_CAPACITY) throw readError({ code: 'BUSY' });
      token = randomUUID();
      snapshot = immutable({
        fingerprint: hash,
        expiresAt: now() + SNAPSHOT_TTL,
        items: immutable([...items]),
      });
      snapshots.set(token, snapshot);
    }
    const end = offset + input.limit;
    return {
      items: snapshot.items.slice(offset, end),
      nextCursor: end < snapshot.items.length ? `${token}.${end}` : null,
      queryId: input.queryId,
    };
  }
  const boundedRows = (data: unknown) => {
    const rows = wireArray(data, RESPONSE_LIMIT);
    if (rows.length === RESPONSE_LIMIT) throw readError({ code: 'BUSY' });
    return rows;
  };

  async function balanceSnapshot(
    context: RequestContext,
    event?: Readonly<Record<string, unknown>>,
  ): Promise<AccountSnapshot> {
    const account = authority(context);
    const response = await signed(
      { path: spot ? '/api/v3/account' : '/fapi/v3/balance', weight: spot ? 20 : 5 },
      context,
    );
    const data = readResponse(response);
    if (event !== undefined) {
      let transactionTime: number;
      let changedAssets: string[];
      if (spot) {
        if (event.e === 'outboundAccountPosition') {
          transactionTime = timestampSchema.parse(wireInteger(event.u));
          changedAssets = wireArray(event.B, 1000).map((item) =>
            assetSchema.parse(wireObject(item).a),
          );
        } else if (event.e === 'balanceUpdate' || event.e === 'externalLockUpdate') {
          transactionTime = timestampSchema.parse(wireInteger(event.T));
          changedAssets = [assetSchema.parse(event.a)];
        } else return invalidResponse();
        const accountData = wireObject(data);
        if (wireInteger(accountData.updateTime) < transactionTime) return invalidResponse();
        const reportedAssets = new Set(
          wireArray(accountData.balances, 1000).map((item) =>
            assetSchema.parse(wireObject(item).asset),
          ),
        );
        if (changedAssets.some((asset) => !reportedAssets.has(asset))) return invalidResponse();
      } else {
        if (event.e !== 'ACCOUNT_UPDATE') return invalidResponse();
        transactionTime = timestampSchema.parse(wireInteger(event.T));
        changedAssets = wireArray(wireObject(event.a).B, 1000).map((item) =>
          assetSchema.parse(wireObject(item).a),
        );
        const assets = new Map(
          wireArray(data, 1000).map((item) => {
            const row = wireObject(item);
            return [assetSchema.parse(row.asset), row] as const;
          }),
        );
        if (
          changedAssets.some((asset) => {
            const row = assets.get(asset);
            return row === undefined || wireInteger(row.updateTime) < transactionTime;
          })
        )
          return invalidResponse();
      }
      if (changedAssets.length === 0 || new Set(changedAssets).size !== changedAssets.length)
        return invalidResponse();
    }
    return spot
      ? normalizeSpotAccount(data, endpoint.scope, account, response.receivedAt)
      : normalizeFuturesBalances(data, endpoint.scope, account, response.receivedAt);
  }

  async function read(
    operation: ReadOperation,
    raw: unknown,
    context: RequestContext,
  ): Promise<unknown> {
    authority(context);
    const parsed = operations[operation].input.safeParse(raw);
    if (!parsed.success) return invalidRequest();
    const input = wireObject(parsed.data);
    if (operation === 'getAccountInfo') return accountInfo(context);
    if (operation === 'testConnection') {
      const info = await accountInfo(context);
      return {
        authenticated: true,
        canRead: true,
        canTrade: info.permissions.includes('TRADE'),
        checkedAt: info.checkedAt,
      };
    }
    if (operation === 'getBalances') return balanceSnapshot(context);
    if (
      !['getPositions', 'getOpenOrders', 'getOrder', 'getOrderHistory', 'getTrades'].includes(
        operation,
      )
    )
      throw new BinanceProtocolError('UNSUPPORTED');
    const value = metadata(input.instrumentId),
      symbol = value.instrument.exchangeSymbol;
    if (operation === 'getOrder') {
      const query = operations.getOrder.input.parse(parsed.data);
      const params = serializeOrderLocator(value, query.locator);
      const response = await signed(
        { path: `${prefix}order`, params, weight: spot ? 4 : 1, symbol },
        context,
      );
      if (response.code === '-2013') return { kind: 'INDETERMINATE', reason: 'NOT_AUTHORITATIVE' };
      const found = normalizeOrder(
        readResponse(response),
        value,
        binding!.account,
        requireIdentities(),
      );
      if (
        query.locator.kind === 'EXCHANGE_ID'
          ? found.exchangeOrderId !== query.locator.id
          : found.clientOrderId !== query.locator.id
      )
        return invalidResponse();
      return { kind: 'FOUND', order: found };
    }
    if (input.cursor !== null) return page(operation, input);
    if (operation === 'getPositions') {
      if (spot) return page(operation, input, []);
      const response = await signed(
        { path: '/fapi/v2/positionRisk', params: { symbol }, weight: 5, symbol },
        context,
      );
      const items = boundedRows(readResponse(response)).map((row) =>
        normalizePositionV2(row, value, binding!.account),
      );
      if (items.length > 1) return invalidResponse();
      return page(operation, input, items);
    }
    let path = `${prefix}openOrders`,
      weight = spot ? 6 : 1;
    const params: Record<string, string> = { symbol };
    let from = 0,
      to = 0;
    if (operation === 'getOrderHistory' || operation === 'getTrades') {
      from = timestampSchema.parse(input.from);
      to = timestampSchema.parse(input.to);
      if (from > to || to - from > (spot ? 1 : 7) * 86_400_000) return invalidRequest();
      if (from === to) return page(operation, input, []);
      path =
        operation === 'getTrades'
          ? `${prefix}${spot ? 'myTrades' : 'userTrades'}`
          : `${prefix}allOrders`;
      weight = spot ? 20 : 5;
      params.startTime = String(from);
      params.endTime = String(to - 1);
      params.limit = String(RESPONSE_LIMIT);
    }
    const response = await signed({ path, params, weight, symbol }, context);
    const rows = boundedRows(readResponse(response));
    const ids = new Set<string>();
    if (operation === 'getTrades') {
      const port = requireIdentities();
      const items = rows
        .map((row) => {
          const data = wireObject(row),
            exchangeOrderId = numericId(data.orderId);
          const item = normalizeFill(
            data,
            value,
            binding!.account,
            port.fill(binding!.account, value.instrument.id, exchangeOrderId),
            response.receivedAt,
          );
          if (item.exchangeTime < from || item.exchangeTime >= to || ids.has(item.fillId))
            return invalidResponse();
          ids.add(item.fillId);
          return item;
        })
        .sort((a, b) => a.exchangeTime - b.exchangeTime || numericCompare(a.fillId, b.fillId));
      return page(operation, input, items);
    }
    const items = rows
      .map((row) => {
        const item = normalizeOrder(row, value, binding!.account, requireIdentities());
        if (item.exchangeOrderId === null || ids.has(item.exchangeOrderId))
          return invalidResponse();
        ids.add(item.exchangeOrderId);
        if (operation === 'getOrderHistory' && (item.createdAt < from || item.createdAt >= to))
          return invalidResponse();
        if (
          operation === 'getOpenOrders' &&
          !['OPEN', 'PENDING', 'PARTIALLY_FILLED'].includes(item.status)
        )
          return invalidResponse();
        return item;
      })
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt || numericCompare(a.exchangeOrderId!, b.exchangeOrderId!),
      );
    return page(operation, input, items);
  }

  async function mutation(
    operation: Exclude<MutationOperation, 'cancelAllOrders'>,
    raw: unknown,
    context: RequestContext,
  ): Promise<MutationOutcome> {
    let dispatched = false;
    try {
      if (endpoint.scope.environment === 'LIVE') return rejected('LIVE_DISABLED');
      const account = authority(context);
      const parsed = operations[operation].input.safeParse(raw);
      if (!parsed.success) return rejected('INVALID_REQUEST');
      const input = immutable(parsed.data);
      if (!['createOrder', 'cancelOrder', 'setLeverage'].includes(operation))
        return rejected('UNSUPPORTED');
      const command = wireObject(input.command);
      const value = metadata(command.instrumentId),
        symbol = value.instrument.exchangeSymbol;
      let spec: RestSpec;
      let validatedOrder: NewOrder | null = null;
      let admissionFingerprint: string | null = null;
      if (operation === 'createOrder') {
        const order = operations.createOrder.input.parse(input).command;
        const serialized = serializeOrder(order, value);
        const staticValidation = validateOrderAgainstRules(order, value, now());
        if (!staticValidation.ok) return rejected(staticValidation.error.code);
        const exchangeAdmission = admission(value.instrument.id);
        validatedOrder = order;
        admissionFingerprint = JSON.stringify(exchangeAdmission);
        if (exchangeAdmission.unsupportedFilters.length > 0) return rejected('UNSUPPORTED');
        if (order.type === 'MARKET' || order.type === 'STOP_MARKET') {
          const marketLot = exchangeAdmission.filters.find(
            (filter) => filter.filterType === 'MARKET_LOT_SIZE',
          );
          if (marketLot !== undefined) {
            const step = parseDecimal(marketLot.stepSize);
            if (step !== '0' && !isStepAligned(order.size.value, step))
              return rejected('INVALID_REQUEST');
          }
        }
        if (!orderAdmission) return rejected('AUTHORIZATION_REQUIRED');
        const admitted = await boundedPort(
          () =>
            orderAdmission.validate(endpoint.id, account, order, value, exchangeAdmission, context),
          context,
          now,
        );
        if (admitted !== true) return rejected('AUTHORIZATION_REQUIRED');
        if (!spot) await accountInfo(context);
        spec = { ...serialized, method: 'POST', symbol };
      } else if (operation === 'cancelOrder') {
        const query = operations.cancelOrder.input.parse(input).command;
        spec = {
          path: `${prefix}order`,
          method: 'DELETE',
          params: serializeOrderLocator(value, query.locator),
          weight: 1,
          orders: 0,
          symbol,
        };
      } else {
        if (spot) return rejected('UNSUPPORTED');
        const leverage = operations.setLeverage.input.parse(input).command.leverage;
        if (!/^(?:[1-9]|[1-9]\d|1[01]\d|12[0-5])$/.test(leverage))
          return rejected('INVALID_REQUEST');
        await accountInfo(context);
        spec = {
          path: '/fapi/v1/leverage',
          method: 'POST',
          params: { symbol, leverage },
          weight: 1,
          orders: 0,
          symbol,
        };
      }
      spec = {
        ...spec,
        onDispatch: () => {
          authority(context);
          const current = metadata(value.instrument.id);
          if (current.instrument.exchangeSymbol !== symbol)
            throw new BinanceProtocolError('SCOPE_MISMATCH');
          if (validatedOrder !== null) {
            if (
              current.instrument.metadataVersion !== value.instrument.metadataVersion ||
              current.rules.version !== value.rules.version
            )
              throw new BinanceProtocolError('STALE_METADATA');
            const validated = validateOrderAgainstRules(validatedOrder, current, now());
            if (!validated.ok) throw readError(validated.error);
            const currentAdmission = admission(current.instrument.id);
            if (currentAdmission.unsupportedFilters.length > 0)
              throw new BinanceProtocolError('UNSUPPORTED');
            if (JSON.stringify(currentAdmission) !== admissionFingerprint)
              throw new BinanceProtocolError('STALE_METADATA');
          }
          assertActive(context, now);
          dispatched = true;
        },
      };
      const response = await signed(spec, context);
      if (response.status >= 500 || response.status === 429 || response.status === 418)
        return unknown();
      if (response.code !== null || response.status < 200 || response.status >= 300) {
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.code !== null &&
          parameterRejections.has(response.code)
        )
          return rejected(
            response.code === '-2014' || response.code === '-2015'
              ? 'AUTHORIZATION_REQUIRED'
              : 'INVALID_REQUEST',
          );
        return unknown();
      }
      const data = wireObject(response.data);
      if (data.symbol !== symbol) return unknown('INVALID_RESPONSE');
      let exchangeId: string | null;
      if (operation === 'setLeverage') {
        if (wireInteger(data.leverage) !== Number(spec.params!.leverage))
          return unknown('INVALID_RESPONSE');
        exchangeId = null;
      } else {
        exchangeId = numericId(data.orderId);
        if (operation === 'createOrder' && data.clientOrderId !== command.clientOrderId)
          return unknown('INVALID_RESPONSE');
        if (operation === 'cancelOrder') {
          const locator = operations.cancelOrder.input.parse(input).command.locator;
          if (
            data.status !== 'CANCELED' ||
            (locator.kind === 'EXCHANGE_ID'
              ? exchangeId !== locator.id
              : (data.origClientOrderId ?? data.clientOrderId) !== locator.id)
          )
            return unknown('INVALID_RESPONSE');
        }
      }
      return immutable({
        kind: 'ACCEPTED',
        ack: {
          commandId: input.authorization.commandId,
          status: 'ACKNOWLEDGED',
          exchangeId,
          receivedAt: response.receivedAt,
        },
      });
    } catch (failure) {
      return dispatched ? unknown(safeCode(failure)) : rejected(safeCode(failure));
    }
  }

  return Object.freeze({
    /** Validate raw per-asset proof before aggregate wallet normalization hides row clocks. */
    async refreshBalances(
      event: Readonly<Record<string, unknown>>,
      context: RequestContext,
    ): Promise<AccountSnapshot> {
      try {
        return await balanceSnapshot(context, event);
      } catch (failure) {
        throw readError(failure);
      }
    },
    async request(
      operation: ReadOperation | MutationOperation,
      input: unknown,
      context: RequestContext,
    ): Promise<unknown> {
      if (operations[operation].kind === 'MUTATION')
        return mutation(operation as Exclude<MutationOperation, 'cancelAllOrders'>, input, context);
      if (operation === 'cancelAllOrders') {
        const parsed = operations.cancelAllOrders.input.safeParse(input);
        if (!parsed.success) return { kind: 'NOT_SENT', error: { code: 'INVALID_REQUEST' } };
        const outcomes = [];
        for (const entry of parsed.data.commands)
          outcomes.push({
            commandId: entry.authorization.commandId,
            outcome: await mutation('cancelOrder', entry, context),
          });
        return immutable({ kind: 'RESULTS', outcomes });
      }
      try {
        return await read(operation as ReadOperation, input, context);
      } catch (failure) {
        throw readError(failure);
      }
    },
  });
}
