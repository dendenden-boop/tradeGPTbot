import type {
  AccountScope,
  AdapterAuthorizationPort,
  CapabilityRecord,
  InstrumentRecord,
  RuntimeInstrumentRegistry,
  WritableInstrumentRegistry as CoreWritableInstrumentRegistry,
  NewOrder,
  RequestContext,
} from '@ctp/exchange-core';
import type { OkxProfileId } from './profiles.js';
import type { IoContext } from './io.js';
import type { OkxAdmission } from './public-data.js';

export interface OkxRateRequest {
  readonly profileId: OkxProfileId;
  readonly accountId: string | null;
  readonly route: string;
  readonly method: 'GET' | 'POST' | 'WS';
  readonly symbol?: string;
  readonly requests: number;
  readonly orders: number;
  readonly connectionAttempts: number;
  readonly controlMessages: number;
}
/** Atomic shared IP, UID, instrument type and native route budgets. */
export interface OkxRateLimitPort {
  reserve(request: OkxRateRequest, context: IoContext): Promise<boolean>;
  observe(
    request: OkxRateRequest,
    status: number,
    headers: Readonly<Record<string, string>>,
    context: IoContext,
  ): Promise<void>;
}
export interface OkxConnectionPort {
  resolve(profileId: OkxProfileId): {
    readonly account: AccountScope;
    readonly credentialRef: string;
  };
}
export interface OkxCredentialPort {
  resolve(
    reference: string,
    profileId: OkxProfileId,
    account: AccountScope,
    context: IoContext,
  ): Promise<{
    readonly profileId: OkxProfileId;
    readonly account: AccountScope;
    readonly apiKey: string;
    readonly secret: string;
    readonly passphrase: string;
  }>;
}
/** Fresh trusted enrollment proof is required in addition to native account/config UID and permissions. */
export interface OkxPermissionPort {
  verify(
    profileId: OkxProfileId,
    account: AccountScope,
    credentialRef: string,
    context: IoContext,
  ): Promise<{
    readonly profileId: OkxProfileId;
    readonly account: AccountScope;
    readonly credentialRef: string;
    readonly canRead: boolean;
    readonly canTrade: boolean;
    readonly withdrawalEnabled: boolean;
    readonly checkedAt: number;
    readonly expiresAt: number;
  }>;
}
export interface OkxSandboxAcceptancePort {
  authorize(
    profileId: OkxProfileId,
    account: AccountScope,
    command: unknown,
    context: RequestContext,
  ): Promise<boolean>;
}
export interface OkxIdentityPort {
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
export interface OkxOrderAdmissionPort {
  validate(
    profileId: OkxProfileId,
    account: AccountScope,
    order: NewOrder,
    record: InstrumentRecord,
    admission: OkxAdmission,
    context: RequestContext,
  ): Promise<boolean>;
}
/** Compatibility name for explicit test/reference transport injection. */
export type WritableInstrumentRegistry = CoreWritableInstrumentRegistry;
export interface OkxAdapterOptions {
  readonly profileId: OkxProfileId;
  readonly symbols: readonly string[];
  readonly capabilities: readonly CapabilityRecord[];
  readonly limiter: OkxRateLimitPort;
  readonly connection?: OkxConnectionPort;
  readonly credentials?: OkxCredentialPort;
  readonly permissions?: OkxPermissionPort;
  readonly authorization?: AdapterAuthorizationPort;
  readonly sandboxAcceptance?: OkxSandboxAcceptancePort;
  readonly identities?: OkxIdentityPort;
  readonly orderAdmission?: OkxOrderAdmissionPort;
  /** Mandatory server-owned runtime port; no reference registry default. */
  readonly registry: RuntimeInstrumentRegistry;
  readonly tradeMode?: 'cross' | 'isolated';
  readonly now?: () => number;
}
