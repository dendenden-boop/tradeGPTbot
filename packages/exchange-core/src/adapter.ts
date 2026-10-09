import { createHash } from 'node:crypto';

import { z } from 'zod';

import { createCursorCodec } from './cursor.js';
import { decimalCompare, isStepAligned } from './decimal.js';
import { immutable, newOrderSchema } from './domain.js';
import type { NewOrder } from './domain.js';
import { failure, sanitizeExchangeError, success } from './errors.js';
import type { ExchangeErrorCode, Result } from './errors.js';
import { authorizationSchema, operations } from './operations.js';
import type {
  Authorization,
  MutationOperation,
  MutationOutcome,
  Operation,
  OperationInput,
  OperationOutput,
  ReadOperation,
  StreamOperation,
} from './operations.js';
import { sameMarketScope, validateOrderAgainstRules } from './registry.js';
import type { InstrumentRegistry } from './registry.js';
import {
  accountScopeSchema,
  adapterProfileSchema,
  capabilityRecordSchema,
  evaluateCapability,
  idSchema,
  marketScopeSchema,
  timestampSchema,
} from './scope.js';
import type {
  AccountScope,
  AdapterProfile,
  CapabilityRecord,
  Feature,
  MarketScope,
} from './scope.js';
import { createSubscription } from './subscription.js';
import type { Subscription } from './subscription.js';

export interface RequestContext {
  readonly profile: AdapterProfile;
  readonly account: AccountScope | null;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly correlationId: string;
}

/** The injected protocol port is trusted server code; no destination comes from a request. */
export interface AdapterTransport {
  /** Trusted protocol assembly opts in per operation. Consume only at actual mutation I/O. */
  readonly dispatchAuthorization?: readonly MutationOperation[];
  request(
    operation: ReadOperation | MutationOperation,
    request: unknown,
    context: RequestContext,
    dispatchGate?: () => Promise<boolean>,
  ): Promise<unknown>;
  subscribe(
    operation: StreamOperation,
    request: unknown,
    context: RequestContext,
    onEvent: (event: unknown) => void,
    onGap: () => void,
  ): Promise<() => Promise<void>>;
  disconnect(): Promise<void>;
}

/** Must verify durable command hashes, dispatch attempts and permits; a TypeScript type is not authority. */
export interface AdapterAuthorizationPort {
  authorize(
    operation: MutationOperation,
    input: unknown,
    context: RequestContext,
  ): Promise<boolean>;
}

export interface ExchangeAdapterOptions {
  readonly profile: unknown;
  readonly account: unknown;
  readonly capabilities: readonly unknown[];
  readonly adapterVersion: string;
  readonly registry: InstrumentRegistry;
  readonly transport: AdapterTransport;
  readonly authorization?: AdapterAuthorizationPort;
  readonly now?: () => number;
  readonly allowSynthetic?: boolean;
}

export type AdapterOperationResult<K extends Operation> = K extends MutationOperation
  ? OperationOutput<K>
  : K extends StreamOperation
    ? Result<Subscription<OperationOutput<K>>>
    : Result<OperationOutput<K>>;

type AdapterMethods = {
  readonly [K in Operation]: (
    input: OperationInput<K>,
    context: RequestContext,
  ) => Promise<AdapterOperationResult<K>>;
};
export type ExchangeAdapter = AdapterMethods & {
  readonly profile: AdapterProfile;
  readonly account: AccountScope | null;
  readonly capabilities: readonly CapabilityRecord[];
  readonly adapterVersion: string;
  execute<K extends Operation>(
    operation: K,
    input: OperationInput<K>,
    context: RequestContext,
  ): Promise<AdapterOperationResult<K>>;
  disconnect(): Promise<void>;
};

const requestContextSchema = z.strictObject({
  profile: adapterProfileSchema,
  account: accountScopeSchema.nullable(),
  deadline: timestampSchema,
  signal: z.instanceof(AbortSignal),
  correlationId: idSchema,
});
type ObjectValue = Record<string, unknown>;
type InternalResult = Result<unknown> | MutationOutcome | OperationOutput<'cancelAllOrders'>;
type AuthorizedEntry = { authorization: Authorization; command: ObjectValue };
type FeatureRequirement = { feature: Feature; instrumentId?: string; timeframe?: string };

function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_OBJECT');
  return value as ObjectValue;
}

/** Sort keys after validation so authorizers can bind the same normalized command bytes. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('INVALID_CANONICAL_VALUE');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(object(value))
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

export function computeCommandHash(
  operation: MutationOperation,
  command: unknown,
  binding: { readonly profile: unknown; readonly account: unknown },
): string {
  try {
    const parsedCommand =
      operation === 'cancelAllOrders'
        ? operations.cancelOrder.input.shape.command.parse(command)
        : operations[operation].input.shape.command.parse(command);
    return createHash('sha256')
      .update(
        canonical({
          operation,
          command: parsedCommand,
          profile: adapterProfileSchema.parse(binding.profile),
          account: accountScopeSchema.parse(binding.account),
        }),
      )
      .digest('hex');
  } catch {
    throw new Error('INVALID_COMMAND_HASH_INPUT');
  }
}

function isMutation(operation: Operation): operation is MutationOperation {
  return operations[operation].kind === 'MUTATION' || operations[operation].kind === 'BATCH';
}
function entries(operation: Operation, input: ObjectValue): AuthorizedEntry[] {
  if (!isMutation(operation)) return [];
  const requests = operation === 'cancelAllOrders' ? input.commands : [input];
  if (!Array.isArray(requests)) throw new Error('INVALID_COMMANDS');
  return requests.map((item: unknown) => {
    const value = object(item);
    return {
      authorization: authorizationSchema.parse(value.authorization),
      command: object(value.command),
    };
  });
}
function instrumentIds(input: unknown, result = new Set<string>()): Set<string> {
  if (input === null || typeof input !== 'object') return result;
  if (Array.isArray(input)) {
    for (const child of input) instrumentIds(child, result);
    return result;
  }
  for (const [key, value] of Object.entries(object(input))) {
    if (key === 'authorization') continue;
    if (key === 'instrumentId' && typeof value === 'string') result.add(value);
    else instrumentIds(value, result);
  }
  return result;
}
function orderCommands(operation: Operation, input: ObjectValue): NewOrder[] {
  if (operation === 'createOrder') return [newOrderSchema.parse(input.command)];
  if (operation === 'amendOrder') return [newOrderSchema.parse(object(input.command).replacement)];
  if (operation === 'createAlgoOrder') return [newOrderSchema.parse(object(input.command).order)];
  return [];
}
function features(operation: Operation, input: ObjectValue): FeatureRequirement[] {
  const definition = operations[operation];
  const required: FeatureRequirement[] = [];
  const add = (feature: Feature, request: ObjectValue): void => {
    const instrumentId = [...instrumentIds(request)][0];
    required.push({
      feature,
      ...(instrumentId === undefined ? {} : { instrumentId }),
      ...(typeof request.timeframe === 'string' ? { timeframe: request.timeframe } : {}),
    });
  };
  const commands = entries(operation, input);
  if (definition.feature !== null && operation !== 'createOrder') {
    for (const command of commands.length ? commands.map((value) => value.command) : [input])
      add(definition.feature, command);
  }
  if (operation === 'getOrder' && object(input.locator).kind === 'CLIENT_ID')
    add('ORDER_LOOKUP_BY_CLIENT_ID', input);
  if (operation === 'cancelAlgoOrder') add('CANCEL_ORDER', object(input.command));
  if (operation === 'subscribeAlgoOrders') add('PRIVATE_STREAM', input);
  for (const order of orderCommands(operation, input)) {
    add(
      order.type === 'LIMIT' || order.type === 'STOP_LIMIT' ? 'LIMIT_ORDER' : 'MARKET_ORDER',
      order,
    );
    if (order.trigger !== null || operation === 'createAlgoOrder') add('TRIGGER_ORDER', order);
    if (order.type === 'STOP_LIMIT') add('STOP_LIMIT_ORDER', order);
    if (order.size.kind === 'QUOTE_BUDGET') add('QUOTE_BUDGET_MARKET_BUY', order);
    if (order.reduceOnly) add('REDUCE_ONLY', order);
  }
  return required;
}

/**
 * Contract boundary only. All protocol I/O and durable authorization are injected;
 * this package provides neither a real exchange transport nor financial writers.
 */
export function createExchangeAdapter(options: ExchangeAdapterOptions): ExchangeAdapter {
  let profile: AdapterProfile;
  let account: AccountScope | null;
  let capabilities: readonly CapabilityRecord[];
  let adapterVersion: string;
  let dispatchAuthorization: ReadonlySet<MutationOperation>;
  try {
    profile = adapterProfileSchema.parse(options.profile);
    account = accountScopeSchema.nullable().parse(options.account);
    capabilities = z.array(capabilityRecordSchema).max(1024).readonly().parse(options.capabilities);
    adapterVersion = idSchema.parse(options.adapterVersion);
    const deferred = options.transport.dispatchAuthorization ?? [];
    if (
      !Array.isArray(deferred) ||
      deferred.length > 32 ||
      new Set(deferred).size !== deferred.length ||
      deferred.some(
        (value) =>
          typeof value !== 'string' ||
          !Object.hasOwn(operations, value) ||
          !isMutation(value as Operation),
      )
    )
      throw new Error();
    dispatchAuthorization = new Set(deferred);
    if (options.allowSynthetic !== undefined && typeof options.allowSynthetic !== 'boolean')
      throw new Error();
  } catch {
    throw new Error('INVALID_ADAPTER_CONFIGURATION');
  }
  const scope: MarketScope = marketScopeSchema.parse({
    exchange: profile.exchange,
    region: profile.region,
    market: profile.market,
    environment: profile.environment,
  });
  const profileBinding = canonical(profile);
  const accountBinding = canonical(account);
  const clock = options.now ?? Date.now;
  const allowSynthetic = options.allowSynthetic === true;
  const requestTransport = options.transport.request.bind(options.transport);
  const subscribeTransport = options.transport.subscribe.bind(options.transport);
  const disconnectTransport = options.transport.disconnect.bind(options.transport);
  const authorize =
    options.authorization?.authorize.bind(options.authorization) ?? (() => Promise.resolve(false));
  const getInstrument = options.registry.get.bind(options.registry);
  const cursorCodec = createCursorCodec();
  const pending = new Set<AbortController>();
  const streams = new Set<AbortController>();
  let closed = false;
  let disconnectPromise: Promise<void> | undefined;

  const now = (): number => timestampSchema.parse(clock());
  const compatibleContext = (context: RequestContext): boolean =>
    canonical(context.profile) === profileBinding && canonical(context.account) === accountBinding;
  const reject = (
    operation: Operation,
    input: ObjectValue | null,
    code: ExchangeErrorCode,
    dispatched: boolean,
  ): InternalResult => {
    if (!isMutation(operation)) return failure(code);
    const outcome: MutationOutcome = dispatched
      ? { kind: 'UNKNOWN', error: { code: 'UNKNOWN_OUTCOME' } }
      : { kind: 'DEFINITIVELY_REJECTED', error: { code } };
    if (operation === 'cancelAllOrders') {
      if (!dispatched) return immutable({ kind: 'NOT_SENT', error: { code } });
      const commands = input === null ? [] : entries(operation, input);
      return immutable({
        kind: 'RESULTS',
        outcomes: commands.map(({ authorization }) => ({
          commandId: authorization.commandId,
          outcome,
        })),
      });
    }
    return immutable(outcome);
  };

  const preflight = (
    operation: Operation,
    input: ObjectValue,
    context: RequestContext,
  ): ExchangeErrorCode | null => {
    const current = now();
    if (closed) return 'CLOSED';
    if (context.signal.aborted) return 'ABORTED';
    if (context.deadline <= current) return 'DEADLINE_EXCEEDED';
    if (context.deadline - current > 30_000) return 'INVALID_REQUEST';
    if (!compatibleContext(context)) return 'SCOPE_MISMATCH';
    if (operations[operation].privateOperation && account === null) return 'AUTHORIZATION_REQUIRED';
    if (isMutation(operation) && profile.environment === 'LIVE') return 'LIVE_DISABLED';
    for (const requirement of features(operation, input)) {
      const candidates = capabilities.filter(
        (record) =>
          record.feature === requirement.feature && canonical(record.profile) === profileBinding,
      );
      // Ambiguous capability records must not select whichever one permits the operation.
      if (candidates.length !== 1) return 'UNVERIFIED';
      const candidate = candidates[0];
      const result = evaluateCapability({
        profile,
        record: candidate,
        now: current,
        adapterVersion,
        ...requirement,
        allowSynthetic,
      });
      if (!result.allowed) {
        if (result.code === 'UNVERIFIED' || result.code === 'MALFORMED') return 'UNVERIFIED';
        if (result.code === 'EXPIRED' || result.code === 'VERSION_MISMATCH')
          return 'STALE_CAPABILITY';
        if (result.code === 'SCOPE_MISMATCH') return 'SCOPE_MISMATCH';
        return 'UNSUPPORTED';
      }
    }
    for (const instrumentId of instrumentIds(input)) {
      const result = getInstrument(scope, instrumentId, current);
      if (!result.ok) return result.error.code;
    }
    for (const order of orderCommands(operation, input)) {
      const record = getInstrument(scope, order.instrumentId, current);
      if (!record.ok) return record.error.code;
      const validation = validateOrderAgainstRules(order, record.value, current);
      if (!validation.ok) return validation.error.code;
    }
    if (operation === 'createAlgoOrder') {
      const command = operations.createAlgoOrder.input.parse(input).command;
      const record = getInstrument(scope, command.order.instrumentId, current);
      if (!record.ok) return record.error.code;
      const { tickSize, minPrice, maxPrice } = record.value.rules;
      if (
        !isStepAligned(command.trigger.price, tickSize) ||
        (minPrice !== null && decimalCompare(command.trigger.price, minPrice) < 0) ||
        (maxPrice !== null && decimalCompare(command.trigger.price, maxPrice) > 0)
      )
        return 'INVALID_REQUEST';
    }
    if (operation === 'amendOrder') {
      const command = operations.amendOrder.input.parse(input).command;
      if (command.target.observedAt > current || current - command.target.observedAt > 5000)
        return 'STALE_METADATA';
    }
    const authorized = entries(operation, input);
    if (
      new Set(authorized.map((entry) => entry.authorization.commandId)).size !==
        authorized.length ||
      new Set(authorized.map((entry) => entry.authorization.dispatchAttemptId)).size !==
        authorized.length
    )
      return 'INVALID_REQUEST';
    for (const entry of authorized) {
      const permit = entry.authorization;
      if (
        canonical(permit.profile) !== profileBinding ||
        canonical(permit.account) !== accountBinding
      )
        return 'SCOPE_MISMATCH';
      if (permit.issuedAt > current || permit.expiresAt <= current) return 'AUTHORIZATION_REQUIRED';
      if (
        !isMutation(operation) ||
        permit.commandHash !== computeCommandHash(operation, entry.command, { profile, account })
      )
        return 'AUTHORIZATION_REQUIRED';
    }
    return null;
  };

  const responseMatches = (operation: Operation, input: ObjectValue, output: unknown): boolean => {
    const expectedIds = instrumentIds(input);
    const walk = (value: unknown): boolean => {
      if (value === null || typeof value !== 'object') return true;
      if (Array.isArray(value)) return value.every(walk);
      const item = object(value);
      if (item.scope !== undefined && !sameMarketScope(marketScopeSchema.parse(item.scope), scope))
        return false;
      if (item.account !== undefined && canonical(item.account) !== accountBinding) return false;
      if (item.accountMode !== undefined && item.accountMode !== profile.accountMode) return false;
      if (
        item.instrumentId !== undefined &&
        expectedIds.size > 0 &&
        (typeof item.instrumentId !== 'string' || !expectedIds.has(item.instrumentId))
      )
        return false;
      if (
        item.exchangeSymbol !== undefined &&
        expectedIds.size > 0 &&
        (typeof item.id !== 'string' || !expectedIds.has(item.id))
      )
        return false;
      if (
        item.timeframe !== undefined &&
        input.timeframe !== undefined &&
        item.timeframe !== input.timeframe
      )
        return false;
      if (
        Array.isArray(item.items) &&
        (item.queryId !== input.queryId ||
          typeof input.limit !== 'number' ||
          item.items.length > input.limit)
      )
        return false;
      return Object.values(item).every(walk);
    };
    if (!walk(output)) return false;
    const value = object(output);
    if (operation === 'getAmendmentEvidence') {
      const command = operations.getAmendmentEvidence.input.parse(input).command,
        recovered = operations.getAmendmentEvidence.output.parse(output);
      if (recovered.receivedAt > now()) return false;
      if (recovered.kind === 'APPLIED_EVIDENCE') {
        const e = recovered.evidence;
        if (
          e.exchangeOrderId !== command.locator.locator.id ||
          e.oldClientOrderId !== command.target.current.clientOrderId ||
          e.newClientOrderId !== command.replacement.clientOrderId ||
          e.originalQuantity !== command.target.current.size.value ||
          e.newQuantity !== command.replacement.size.value ||
          e.time < command.target.nativeUpdatedAt ||
          e.time > recovered.receivedAt
        )
          return false;
      }
    }
    if (
      Array.isArray(value.items) &&
      typeof input.from === 'number' &&
      typeof input.to === 'number'
    ) {
      const { from, to } = input;
      const timeField =
        operation === 'getHistoricalCandles'
          ? 'openTime'
          : operation === 'getTrades'
            ? 'exchangeTime'
            : operation === 'getOrderHistory'
              ? 'createdAt'
              : operation === 'getAlgoHistory'
                ? 'updatedAt'
                : undefined;
      if (
        timeField !== undefined &&
        value.items.some((item) => {
          const timestamp = object(item)[timeField];
          return typeof timestamp !== 'number' || timestamp < from || timestamp >= to;
        })
      )
        return false;
    }
    if (
      operation === 'getOpenOrders' &&
      Array.isArray(value.items) &&
      value.items.some((item) => {
        const status = object(item).status;
        return (
          typeof status !== 'string' || !['PENDING', 'OPEN', 'PARTIALLY_FILLED'].includes(status)
        );
      })
    )
      return false;
    if (operation === 'getOrder') {
      const locator = object(input.locator);
      if (value.kind === 'FOUND') {
        const order = object(value.order);
        if (
          (locator.kind === 'CLIENT_ID' ? order.clientOrderId : order.exchangeOrderId) !==
          locator.id
        )
          return false;
      }
      if (
        value.kind === 'NOT_FOUND_WITH_SCOPE' &&
        (!Array.isArray(value.queriedIds) ||
          value.queriedIds.length !== 1 ||
          value.queriedIds[0] !== locator.id)
      )
        return false;
    }
    if (operation === 'getAlgoOrder' && value.clientAlgoId !== input.clientAlgoId) return false;
    if (
      (operation === 'getOrderBook' || operation === 'subscribeOrderBook') &&
      typeof input.depth === 'number' &&
      ((Array.isArray(value.bids) && value.bids.length > input.depth) ||
        (Array.isArray(value.asks) && value.asks.length > input.depth))
    )
      return false;
    const authorized = entries(operation, input);
    const matchesAck = (outcome: ObjectValue, commandId: string): boolean =>
      outcome.kind !== 'ACCEPTED' || object(outcome.ack).commandId === commandId;
    if (operation === 'cancelAllOrders') {
      const expected = new Set(authorized.map((entry) => entry.authorization.commandId));
      if (
        value.kind !== 'RESULTS' ||
        !Array.isArray(value.outcomes) ||
        value.outcomes.length !== expected.size
      )
        return false;
      for (const item of value.outcomes) {
        const outcome = object(item);
        if (
          typeof outcome.commandId !== 'string' ||
          !expected.delete(outcome.commandId) ||
          !matchesAck(object(outcome.outcome), outcome.commandId)
        )
          return false;
      }
      return expected.size === 0;
    }
    return authorized.every((entry) => matchesAck(value, entry.authorization.commandId));
  };

  const cursorBinding = (operation: Operation, input: ObjectValue): string => {
    const { cursor: _cursor, ...filters } = input;
    void _cursor;
    return canonical({ operation, profile, account, filters });
  };

  async function executeInternal(
    operation: Operation,
    rawInput: unknown,
    rawContext: RequestContext,
  ): Promise<InternalResult> {
    let input: ObjectValue | null = null;
    let dispatched = false;
    let context: RequestContext;
    let initialTime: number;
    try {
      input = immutable(object(operations[operation].input.parse(rawInput)));
      context = Object.freeze(requestContextSchema.parse(rawContext));
      const refusal = preflight(operation, input, context);
      if (refusal !== null) return reject(operation, input, refusal, false);
      initialTime = now();
    } catch {
      return reject(operation, input, 'INVALID_REQUEST', false);
    }
    if (pending.size >= 16) return reject(operation, input, 'BUSY', false);
    if (operations[operation].kind === 'STREAM' && streams.size >= 16)
      return reject(operation, input, 'BUSY', false);

    const request = input;
    const controller = new AbortController();
    pending.add(controller);
    const internalContext: RequestContext = Object.freeze({
      ...context,
      profile,
      account,
      signal: controller.signal,
    });
    let cancellationCode: ExchangeErrorCode = 'ABORTED';
    const onUserAbort = (): void => {
      cancellationCode = 'ABORTED';
      controller.abort();
    };
    context.signal.addEventListener('abort', onUserAbort, { once: true });
    if (context.signal.aborted) onUserAbort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelListener: (() => void) | undefined;
    const cancelled = new Promise<InternalResult>((resolve) => {
      cancelListener = () =>
        resolve(reject(operation, request, closed ? 'CLOSED' : cancellationCode, dispatched));
      controller.signal.addEventListener('abort', cancelListener, { once: true });
      if (controller.signal.aborted) cancelListener();
      timeout = setTimeout(
        () => {
          cancellationCode = 'DEADLINE_EXCEEDED';
          controller.abort();
        },
        Math.max(0, context.deadline - initialTime),
      );
    });

    let gateClosed = false;
    const work = async (): Promise<InternalResult> => {
      try {
        const refreshCurrent = async (): Promise<ExchangeErrorCode | null> => {
          if (!options.registry.readCurrent) return null;
          for (const id of instrumentIds(request)) {
            const current = await options.registry.readCurrent(scope, id, now(), internalContext);
            if (!current.ok) return current.error.code;
          }
          return null;
        };
        if (options.registry.readCurrent) {
          const initialMetadata = await refreshCurrent();
          if (initialMetadata !== null) return reject(operation, request, initialMetadata, false);
        }
        const deferred = isMutation(operation) && dispatchAuthorization.has(operation);
        if (isMutation(operation) && !deferred) {
          const authorized = await authorize(operation, request, internalContext);
          if (authorized !== true)
            return reject(operation, request, 'AUTHORIZATION_REQUIRED', false);
          if (options.registry.readCurrent) {
            const currentMetadata = await refreshCurrent();
            if (currentMetadata !== null) return reject(operation, request, currentMetadata, false);
          }
        }
        // Authorization can suspend; every time-dependent guard must be repeated.
        const refusal = preflight(operation, request, internalContext);
        if (refusal !== null) return reject(operation, request, refusal, false);
        let transportRequest = request;
        if (typeof request.cursor === 'string') {
          const rawCursor = cursorCodec.decode(
            request.cursor,
            cursorBinding(operation, request),
            now(),
          );
          if (rawCursor === null) return reject(operation, request, 'INVALID_REQUEST', false);
          transportRequest = immutable({ ...request, cursor: rawCursor });
        }
        if (operations[operation].kind === 'STREAM') {
          const streamOperation = operation as StreamOperation;
          const openedMetadata = new Map(
            [...instrumentIds(request)].map((id) => {
              const record = getInstrument(scope, id, now());
              if (!record.ok) throw new Error('STALE_STREAM_METADATA');
              return [id, record.value] as const;
            }),
          );
          const streamController = new AbortController();
          streams.add(streamController);
          let sourceClose: (() => Promise<void>) | undefined;
          let sourceClosed = false;
          let terminal = false;
          const closeSource = (): void => {
            if (!sourceClose || sourceClosed) return;
            sourceClosed = true;
            try {
              void Promise.resolve(sourceClose()).then(
                () => {
                  streams.delete(streamController);
                },
                () => {
                  streams.delete(streamController);
                },
              );
            } catch {
              streams.delete(streamController);
            }
          };
          const onStreamAbort = (): void => streamController.abort();
          context.signal.addEventListener('abort', onStreamAbort, { once: true });
          controller.signal.addEventListener('abort', onStreamAbort, { once: true });
          const expiry = Math.min(
            context.deadline,
            ...features(operation, request).map(
              (requirement) =>
                capabilities.find(
                  (record) =>
                    record.feature === requirement.feature &&
                    canonical(record.profile) === profileBinding,
                )?.expiresAt ?? now(),
            ),
          );
          const producer = createSubscription({
            capacity: 64,
            now,
            deadline: expiry,
            signal: streamController.signal,
            parse(value: unknown): unknown {
              for (const [id, opened] of openedMetadata) {
                const current = getInstrument(scope, id, now());
                if (
                  !current.ok ||
                  current.value.instrument.metadataVersion !== opened.instrument.metadataVersion ||
                  current.value.rules.version !== opened.rules.version
                )
                  throw new Error('STALE_STREAM_METADATA');
              }
              const checked = operations[operation].output.parse(value);
              if (!responseMatches(operation, request, checked))
                throw new Error('INVALID_STREAM_SCOPE');
              return immutable(checked);
            },
            onClose(): void {
              terminal = true;
              context.signal.removeEventListener('abort', onStreamAbort);
              controller.signal.removeEventListener('abort', onStreamAbort);
              streamController.abort();
              closeSource();
            },
          });
          if (context.signal.aborted || controller.signal.aborted) streamController.abort();
          if (terminal) {
            streams.delete(streamController);
            return failure('STALE_CAPABILITY');
          }
          try {
            dispatched = true;
            sourceClose = await subscribeTransport(
              streamOperation,
              transportRequest,
              Object.freeze({ ...internalContext, signal: streamController.signal }),
              (value) => {
                producer.push(value);
              },
              () => producer.gap(),
            );
            if (typeof sourceClose !== 'function') throw new Error('INVALID_STREAM_SOURCE');
            if (terminal) closeSource();
            return success(producer.subscription);
          } catch {
            streamController.abort();
            streams.delete(streamController);
            return failure('UNAVAILABLE');
          }
        }
        let gateAttempted = false;
        const dispatchGate = deferred
          ? async (): Promise<boolean> => {
              if (gateAttempted || gateClosed) return false;
              gateAttempted = true;
              if (controller.signal.aborted || closed || now() >= context.deadline) return false;
              const current = await refreshCurrent();
              if (current !== null || preflight(operation, request, internalContext) !== null)
                return false;
              if (
                !isMutation(operation) ||
                (await authorize(operation, request, internalContext)) !== true
              )
                return false;
              // No further awaited port after durable authorization and before transport handoff.
              if (preflight(operation, request, internalContext) !== null) return false;
              dispatched = true;
              return true;
            }
          : undefined;
        if (!deferred) dispatched = true;
        const rawOutput = await requestTransport(
          operation as ReadOperation | MutationOperation,
          transportRequest,
          internalContext,
          dispatchGate,
        );
        if (controller.signal.aborted) return reject(operation, request, 'ABORTED', dispatched);
        if (now() >= context.deadline)
          return reject(operation, request, 'DEADLINE_EXCEEDED', dispatched);
        let output: unknown;
        try {
          output = operations[operation].output.parse(rawOutput);
          if (!responseMatches(operation, request, output))
            return reject(operation, request, 'SCOPE_MISMATCH', dispatched);
        } catch {
          return reject(operation, request, 'INVALID_RESPONSE', dispatched);
        }
        if (deferred && !dispatched && object(output).kind !== 'DEFINITIVELY_REJECTED')
          return reject(operation, request, 'AUTHORIZATION_REQUIRED', false);
        if (isMutation(operation))
          return immutable(output) as MutationOutcome | OperationOutput<'cancelAllOrders'>;
        const value = object(output);
        if (typeof value.nextCursor === 'string') {
          if (!idSchema.safeParse(value.nextCursor).success) return failure('INVALID_RESPONSE');
          output = {
            ...value,
            nextCursor: cursorCodec.encode(
              value.nextCursor,
              cursorBinding(operation, request),
              now(),
            ),
          };
        }
        return success(immutable(output));
      } catch (error: unknown) {
        let code: ExchangeErrorCode = 'UNAVAILABLE';
        try {
          code = sanitizeExchangeError(error).code;
        } catch {
          /* Do not expose hostile errors. */
        }
        return reject(operation, request, code, dispatched);
      }
    };
    const settled = work().finally(() => {
      gateClosed = true;
      pending.delete(controller);
    });
    try {
      return await Promise.race([settled, cancelled]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      context.signal.removeEventListener('abort', onUserAbort);
      if (cancelListener !== undefined)
        controller.signal.removeEventListener('abort', cancelListener);
    }
  }

  const execute = <K extends Operation>(
    operation: K,
    input: OperationInput<K>,
    context: RequestContext,
  ): Promise<AdapterOperationResult<K>> => {
    if (typeof operation !== 'string' || !Object.hasOwn(operations, operation))
      return Promise.resolve(failure('INVALID_REQUEST')) as Promise<AdapterOperationResult<K>>;
    return executeInternal(operation, input, context) as Promise<AdapterOperationResult<K>>;
  };
  const methods = Object.fromEntries(
    (Object.keys(operations) as Operation[]).map((operation) => [
      operation,
      (input: OperationInput<typeof operation>, context: RequestContext) =>
        execute(operation, input, context),
    ]),
  ) as AdapterMethods;

  return Object.freeze({
    ...methods,
    profile,
    account,
    capabilities,
    adapterVersion,
    execute,
    disconnect(): Promise<void> {
      if (disconnectPromise !== undefined) return disconnectPromise;
      closed = true;
      for (const controller of pending) controller.abort();
      for (const controller of streams) controller.abort();
      let timer: ReturnType<typeof setTimeout>;
      const bounded = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000);
      });
      const close = Promise.resolve()
        .then(disconnectTransport)
        .then(
          () => undefined,
          () => undefined,
        );
      disconnectPromise = Promise.race([close, bounded]).finally(() => clearTimeout(timer));
      return disconnectPromise;
    },
  });
}
