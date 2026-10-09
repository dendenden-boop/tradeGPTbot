import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  operations,
  immutable,
  evaluateCapability,
  errorCodeSchema,
  timestampSchema,
  type ExchangeAdapter,
  type RequestContext,
} from '@ctp/exchange-core';
import type { BinanceCollateralEvidence } from './ports.js';

interface Owner {
  readonly runtime: boolean;
  readonly readable: boolean;
  readonly now: () => number;
  readonly collect: (input: unknown, context: RequestContext) => Promise<BinanceCollateralEvidence>;
  active: boolean;
}
const owners = new WeakMap<ExchangeAdapter, Owner>();
const ioSchema = z.strictObject({ signal: z.instanceof(AbortSignal), deadline: timestampSchema });
const sourceErrorSchema = z.enum([
  'INVALID_BINANCE_COLLATERAL_SOURCE',
  'BINANCE_COLLATERAL_BUSY',
  'BINANCE_COLLATERAL_ABORTED',
  'BINANCE_COLLATERAL_FAILED',
]);
/** Internal owner registration; absent from the production package exports. */
export function registerBinanceCollateralOwner(
  adapter: ExchangeAdapter,
  owner: Omit<Owner, 'active'>,
): void {
  if (owners.has(adapter)) throw new Error('INVALID_BINANCE_COLLATERAL_SOURCE');
  owners.set(adapter, { ...owner, active: false });
}
/** Bind the read-only collector to an actual runtime Binance assembly, never a structural DTO. */
export function createBinanceCollateralSource(adapter: ExchangeAdapter) {
  const owner = owners.get(adapter);
  if (
    !owner ||
    !owner.runtime ||
    !owner.readable ||
    !adapter.account ||
    adapter.profile.endpointProfileId !== 'binance-spot-testnet-v1'
  )
    throw new Error('INVALID_BINANCE_COLLATERAL_SOURCE');
  let closed = false;
  const pending = new Set<AbortController>();
  const settlements = new Set<Promise<void>>();
  return Object.freeze({
    async collect(
      raw: unknown,
      io: { signal: AbortSignal; deadline: number },
    ): Promise<BinanceCollateralEvidence> {
      if (closed || owner.active) throw new Error('BINANCE_COLLATERAL_BUSY');
      const parsedIo = ioSchema.safeParse(io);
      if (!parsedIo.success) throw new Error('INVALID_BINANCE_COLLATERAL_SOURCE');
      io = parsedIo.data;
      if (io.signal.aborted || io.deadline <= owner.now())
        throw new Error('BINANCE_COLLATERAL_ABORTED');
      const input = operations.getOrder.input.parse(raw);
      if (input.locator.kind !== 'EXCHANGE_ID')
        throw new Error('INVALID_BINANCE_COLLATERAL_SOURCE');
      owner.active = true;
      const controller = new AbortController(),
        abort = () => controller.abort();
      const deadline = Math.min(io.deadline, owner.now() + 5000);
      const timer = setTimeout(abort, Math.max(1, deadline - owner.now()));
      const context: RequestContext = Object.freeze({
        profile: adapter.profile,
        account: adapter.account,
        signal: controller.signal,
        deadline,
        correlationId: randomUUID(),
      });
      let settle = () => {};
      const settlement = new Promise<void>((resolve) => {
        settle = resolve;
      });
      pending.add(controller);
      settlements.add(settlement);
      io.signal.addEventListener('abort', abort, { once: true });
      try {
        for (const feature of ['ACCOUNT_READ', 'ORDER_READ'] as const) {
          const records = adapter.capabilities.filter((record) => record.feature === feature);
          const capability = evaluateCapability({
            profile: adapter.profile,
            record: records.length === 1 ? records[0] : null,
            feature,
            now: owner.now(),
            adapterVersion: adapter.adapterVersion,
            instrumentId: input.instrumentId,
          });
          if (!capability.allowed || capability.implementation !== 'NATIVE')
            throw new Error('UNSUPPORTED');
        }
        // Warm/read the durable current registry through Core before using the private protocol cache.
        const metadata = await adapter.getSymbolInfo({ instrumentId: input.instrumentId }, context);
        if (!metadata.ok) throw new Error(metadata.error.code);
        const account = await adapter.getAccountInfo({}, context);
        if (!account.ok) throw new Error(account.error.code);
        if (account.value.accountMode !== 'SPOT' || !account.value.permissions.includes('READ'))
          throw new Error('INVALID_BINANCE_COLLATERAL_SOURCE');
        const evidence = await owner.collect(input, context);
        if (controller.signal.aborted || closed || owner.now() >= deadline)
          throw new Error('BINANCE_COLLATERAL_ABORTED');
        return immutable(evidence);
      } catch (error) {
        const candidate = error instanceof Error ? error.message : undefined;
        const parsed = z.union([sourceErrorSchema, errorCodeSchema]).safeParse(candidate);
        const code = controller.signal.aborted
          ? 'BINANCE_COLLATERAL_ABORTED'
          : parsed.success
            ? parsed.data
            : 'BINANCE_COLLATERAL_FAILED';
        // The protocol/credential cause is deliberately replaced to prevent secret disclosure.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(code, { cause: new Error('BINANCE_COLLATERAL_FAILED') });
      } finally {
        clearTimeout(timer);
        io.signal.removeEventListener('abort', abort);
        pending.delete(controller);
        settlements.delete(settlement);
        owner.active = false;
        settle();
      }
    },
    async close(): Promise<void> {
      closed = true;
      for (const controller of pending) controller.abort();
      await Promise.allSettled(settlements);
    },
  });
}
export type BinanceCollateralSource = ReturnType<typeof createBinanceCollateralSource>;
