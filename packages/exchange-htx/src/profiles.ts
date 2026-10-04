import { immutable, type AdapterProfile, type MarketScope } from '@ctp/exchange-core';
import { z } from 'zod';
export const htxProfileIds = ['htx-spot-live-v1', 'htx-linear-live-v1'] as const;
export const htxProfileIdSchema = z.enum(htxProfileIds);
export type HtxProfileId = z.infer<typeof htxProfileIdSchema>;
export interface HtxEndpointProfile {
  readonly id: HtxProfileId;
  readonly scope: MarketScope;
  readonly spot: boolean;
  readonly rest: string;
  readonly publicWs: string;
  readonly privateWs: string;
}
const profiles = new Map<HtxProfileId, HtxEndpointProfile>(
  htxProfileIds.map((id) => {
    const spot = id === 'htx-spot-live-v1';
    return [
      id,
      immutable({
        id,
        spot,
        scope: {
          exchange: 'HTX' as const,
          region: 'global',
          environment: 'LIVE' as const,
          market: spot ? ('SPOT' as const) : ('LINEAR_PERPETUAL' as const),
        },
        rest: spot ? 'https://api.huobi.pro' : 'https://api.hbdm.com',
        publicWs: spot ? 'wss://api.huobi.pro/ws' : 'wss://api.hbdm.com/linear-swap-ws',
        privateWs: spot
          ? 'wss://api.huobi.pro/ws/v2'
          : 'wss://api.hbdm.com/linear-swap-notification',
      }),
    ];
  }),
);
export function getHtxProfile(id: HtxProfileId): HtxEndpointProfile {
  const x = profiles.get(htxProfileIdSchema.parse(id));
  if (!x) throw new Error('INVALID_HTX_PROFILE');
  return x;
}
export function adapterProfile(
  endpoint: HtxEndpointProfile,
  credentialRef?: string,
): AdapterProfile {
  return immutable({
    ...endpoint.scope,
    accountMode: endpoint.spot ? 'SPOT_CASH' : 'SINGLE_ASSET_CROSS_HEDGE',
    profileVersion: 'v1',
    endpointProfileId: endpoint.id,
    ...(credentialRef === undefined ? {} : { credentialRef }),
  });
}
export const spotSymbolSchema = z.string().regex(/^[a-z0-9]{2,48}$/);
export const linearSymbolSchema = z.string().regex(/^[A-Z0-9]{1,24}-USDT$/);
