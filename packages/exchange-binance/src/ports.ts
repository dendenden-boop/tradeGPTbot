import type {
  AccountScope,
  AdapterAuthorizationPort,
  CapabilityRecord,
  InstrumentRecord,
  RuntimeInstrumentRegistry,
  WritableInstrumentRegistry as CoreWritableInstrumentRegistry,
  NewOrder,
  RequestContext,
  AccountSnapshot,
  Order,
  AdapterProfile,
} from '@ctp/exchange-core';
import type { BinanceProfileId } from './profiles.js';
import type { IoContext } from './io.js';
import type { BinanceAdmission } from './public-data.js';

/** Read-only native facts. A parsed DTO is not a Risk grant or a monetary writer. */
export interface BinanceCollateralEvidence {
  readonly protocol: 'BINANCE_SPOT_LIMIT_LOCK_V1';
  readonly profile: AdapterProfile;
  readonly account: AccountScope;
  readonly metadataVersion: string;
  readonly ruleVersion: string;
  readonly before: {
    readonly order: Order;
    readonly receivedAt: number;
    readonly sourceHash: string;
    readonly working: true;
  };
  readonly balances: AccountSnapshot;
  readonly after: {
    readonly order: Order;
    readonly receivedAt: number;
    readonly sourceHash: string;
    readonly working: true;
  };
}

export interface BinanceRateRequest {
  readonly profileId: BinanceProfileId;
  readonly accountId: string | null;
  readonly route: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'WS';
  readonly symbol?: string;
  readonly weight: number;
  readonly orders: number;
  readonly connectionAttempts: number;
  readonly controlMessages: number;
}
/** Implement atomically across egress/account/endpoint/symbol budgets; a local process counter is insufficient. */
export interface BinanceRateLimitPort {
  reserve(request: BinanceRateRequest, context: IoContext): Promise<boolean>;
  observe(
    request: BinanceRateRequest,
    status: number,
    headers: Readonly<Record<string, string>>,
    context: IoContext,
  ): Promise<void>;
}
/** A trusted server resolver, never values copied from HTTP headers/body or a queue tenant hint. */
export interface BinanceConnectionPort {
  resolve(profileId: BinanceProfileId): {
    readonly account: AccountScope;
    readonly credentialRef: string;
  };
}
export interface BinanceCredentialPort {
  resolve(
    reference: string,
    profileId: BinanceProfileId,
    account: AccountScope,
    context: IoContext,
  ): Promise<{
    readonly profileId: BinanceProfileId;
    readonly account: AccountScope;
    readonly apiKey: string;
    readonly secret: string;
  }>;
}
export interface BinanceSandboxAcceptancePort {
  authorize(
    profileId: BinanceProfileId,
    account: AccountScope,
    command: unknown,
    context: RequestContext,
  ): Promise<boolean>;
}
export interface BinanceIdentityPort {
  order(
    account: AccountScope,
    instrumentId: string,
    exchangeOrderId: string,
    clientOrderId: string,
  ): { readonly internalOrderId: string; readonly intentId: string };
  algo(
    account: AccountScope,
    instrumentId: string,
    exchangeAlgoId: string,
    clientAlgoId: string,
  ): { readonly internalAlgoId: string };
  fill(
    account: AccountScope,
    instrumentId: string,
    exchangeOrderId: string,
  ): { readonly internalOrderId: string };
}
/** Must verify current dynamic/account filters as well as symbol rules; an absent/unknown budget denies new risk. */
export interface BinanceOrderAdmissionPort {
  validate(
    profileId: BinanceProfileId,
    account: AccountScope,
    order: NewOrder,
    record: InstrumentRecord,
    admission: BinanceAdmission,
    context: RequestContext,
  ): Promise<boolean>;
}
/** Compatibility name for explicit test/reference transport injection. */
export type WritableInstrumentRegistry = CoreWritableInstrumentRegistry;
export interface BinanceAdapterOptions {
  readonly profileId: BinanceProfileId;
  readonly symbols: readonly string[];
  readonly capabilities: readonly CapabilityRecord[];
  readonly limiter: BinanceRateLimitPort;
  readonly connection?: BinanceConnectionPort;
  readonly credentials?: BinanceCredentialPort;
  readonly authorization?: AdapterAuthorizationPort;
  readonly sandboxAcceptance?: BinanceSandboxAcceptancePort;
  readonly identities?: BinanceIdentityPort;
  readonly orderAdmission?: BinanceOrderAdmissionPort;
  /** Mandatory server-owned runtime port; no reference registry default. */
  readonly registry: RuntimeInstrumentRegistry;
  readonly now?: () => number;
}
