import type {
  AccountScope,
  AdapterAuthorizationPort,
  CapabilityRecord,
  InstrumentRecord,
  RuntimeInstrumentRegistry,
  WritableInstrumentRegistry as CoreWritableInstrumentRegistry,
  NewOrder,
  RequestContext,
  Result,
} from '@ctp/exchange-core';
import type { BybitProfileId } from './profiles.js';
import type { IoContext } from './io.js';
import type { BybitAdmission } from './public-data.js';

export interface BybitRateRequest {
  readonly profileId: BybitProfileId;
  readonly accountId: string | null;
  readonly route: string;
  readonly method: 'GET' | 'POST' | 'WS';
  readonly symbol?: string;
  readonly requests: number;
  readonly orders: number;
  readonly connectionAttempts: number;
  readonly controlMessages: number;
}
/** Atomic shared egress IP, UID, category and endpoint budgets; quotas come from actual account evidence/headers. */
export interface BybitRateLimitPort {
  reserve(request: BybitRateRequest, context: IoContext): Promise<boolean>;
  observe(
    request: BybitRateRequest,
    status: number,
    headers: Readonly<Record<string, string>>,
    context: IoContext,
  ): Promise<void>;
}
export interface BybitConnectionPort {
  resolve(profileId: BybitProfileId): {
    readonly account: AccountScope;
    readonly credentialRef: string;
  };
}
export interface BybitCredentialPort {
  resolve(
    reference: string,
    profileId: BybitProfileId,
    account: AccountScope,
    context: IoContext,
  ): Promise<{
    readonly profileId: BybitProfileId;
    readonly account: AccountScope;
    readonly apiKey: string;
    readonly secret: string;
  }>;
}
/** Fresh trusted enrollment/permission proof; never user supplied. UID/profile/key reference must match exactly. */
export interface BybitPermissionPort {
  verify(
    profileId: BybitProfileId,
    account: AccountScope,
    credentialRef: string,
    context: IoContext,
  ): Promise<{
    readonly profileId: BybitProfileId;
    readonly account: AccountScope;
    readonly credentialRef: string;
    readonly canRead: boolean;
    readonly canTrade: boolean;
    readonly withdrawalEnabled: boolean;
    readonly checkedAt: number;
    readonly expiresAt: number;
  }>;
}
export interface BybitSandboxAcceptancePort {
  authorize(
    profileId: BybitProfileId,
    account: AccountScope,
    command: unknown,
    context: RequestContext,
  ): Promise<boolean>;
}
export interface BybitIdentityPort {
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
export interface BybitOrderAdmissionPort {
  validate(
    profileId: BybitProfileId,
    account: AccountScope,
    order: NewOrder,
    record: InstrumentRecord,
    admission: BybitAdmission,
    context: RequestContext,
  ): Promise<boolean>;
}
/** Compatibility name for explicit test/reference transport injection. */
export interface WritableInstrumentRegistry extends CoreWritableInstrumentRegistry {
  put(record: InstrumentRecord, now: number): Result<InstrumentRecord>;
}
export interface BybitAdapterOptions {
  readonly profileId: BybitProfileId;
  readonly symbols: readonly string[];
  readonly capabilities: readonly CapabilityRecord[];
  readonly limiter: BybitRateLimitPort;
  readonly connection?: BybitConnectionPort;
  readonly credentials?: BybitCredentialPort;
  readonly permissions?: BybitPermissionPort;
  readonly authorization?: AdapterAuthorizationPort;
  readonly sandboxAcceptance?: BybitSandboxAcceptancePort;
  readonly identities?: BybitIdentityPort;
  readonly orderAdmission?: BybitOrderAdmissionPort;
  /** Mandatory server-owned runtime port; no reference registry default. */
  readonly registry: RuntimeInstrumentRegistry;
  readonly now?: () => number;
}
