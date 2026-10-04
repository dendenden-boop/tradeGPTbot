import type {
  AccountScope,
  CapabilityRecord,
  RuntimeInstrumentRegistry,
  WritableInstrumentRegistry,
} from '@ctp/exchange-core';
import type { HtxProfileId } from './profiles.js';
import type { IoContext } from './io.js';
export type { WritableInstrumentRegistry };
export interface HtxRateRequest {
  readonly profileId: HtxProfileId;
  readonly accountId: string | null;
  readonly route: string;
  readonly method: 'GET' | 'POST' | 'WS';
  readonly symbol?: string;
  readonly requests: number;
  readonly orders: number;
  readonly connectionAttempts: number;
  readonly controlMessages: number;
}
/** Atomic server-wide IP and UID/route budgets; POST reads are not order mutations. */
export interface HtxRateLimitPort {
  reserve(request: HtxRateRequest, context: IoContext): Promise<boolean>;
  observe(
    request: HtxRateRequest,
    status: number,
    headers: Readonly<Record<string, string>>,
    context: IoContext,
  ): Promise<void>;
}
export interface HtxConnectionPort {
  resolve(profileId: HtxProfileId): {
    readonly account: AccountScope;
    readonly credentialRef: string;
    readonly spotAccountId?: string;
  };
}
export interface HtxCredentialPort {
  resolve(
    reference: string,
    profileId: HtxProfileId,
    account: AccountScope,
    context: IoContext,
  ): Promise<{
    readonly profileId: HtxProfileId;
    readonly account: AccountScope;
    readonly apiKey: string;
    readonly secret: string;
  }>;
}
/** Server enrollment proof: exact product/account mode and no withdrawal privileges, fresh <=30s. */
export interface HtxPermissionPort {
  verify(
    profileId: HtxProfileId,
    account: AccountScope,
    credentialRef: string,
    context: IoContext,
  ): Promise<{
    readonly profileId: HtxProfileId;
    readonly account: AccountScope;
    readonly credentialRef: string;
    readonly accountMode: 'SPOT_CASH' | 'SINGLE_ASSET_CROSS_HEDGE';
    readonly canRead: boolean;
    readonly canTrade: boolean;
    readonly withdrawalEnabled: boolean;
    readonly checkedAt: number;
    readonly expiresAt: number;
  }>;
}
export interface HtxIdentityPort {
  order(
    account: AccountScope,
    instrumentId: string,
    exchangeOrderId: string,
    clientOrderId: string,
  ): { readonly internalOrderId: string; readonly intentId: string };
  fill(
    account: AccountScope,
    instrumentId: string,
    exchangeOrderId: string,
  ): { readonly internalOrderId: string };
}
export interface HtxAdapterOptions {
  readonly profileId: HtxProfileId;
  readonly symbols: readonly string[];
  readonly capabilities: readonly CapabilityRecord[];
  readonly limiter: HtxRateLimitPort;
  /** Mandatory durable owner with anti-reuse/restart history, never an implicit reference default. */
  readonly registry: RuntimeInstrumentRegistry;
  readonly connection?: HtxConnectionPort;
  readonly credentials?: HtxCredentialPort;
  readonly permissions?: HtxPermissionPort;
  readonly identities?: HtxIdentityPort;
  readonly now?: () => number;
}
