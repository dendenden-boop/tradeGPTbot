import { immutable, type AdapterProfile, type MarketScope } from '@ctp/exchange-core';
import { z } from 'zod';

export const okxProfileIds = [
  'okx-spot-live-v1',
  'okx-spot-demo-v1',
  'okx-swap-live-v1',
  'okx-swap-demo-v1',
] as const;
export const okxProfileIdSchema = z.enum(okxProfileIds);
export type OkxProfileId = z.infer<typeof okxProfileIdSchema>;
export interface OkxEndpointProfile {
  readonly id: OkxProfileId;
  readonly scope: MarketScope;
  readonly instType: 'SPOT' | 'SWAP';
  readonly demo: boolean;
  readonly rest: string;
  readonly publicWs: string;
  readonly privateWs: string;
  readonly businessWs: string;
}
const profiles = new Map<OkxProfileId, OkxEndpointProfile>(
  okxProfileIds.map((id) => {
    const demo = id.includes('-demo-'),
      spot = id.includes('-spot-');
    const host = demo ? 'wspap.okx.com' : 'ws.okx.com';
    return [
      id,
      immutable({
        id,
        demo,
        instType: spot ? ('SPOT' as const) : ('SWAP' as const),
        scope: {
          exchange: 'OKX' as const,
          region: 'global',
          environment: demo ? ('DEMO' as const) : ('LIVE' as const),
          market: spot ? ('SPOT' as const) : ('LINEAR_PERPETUAL' as const),
        },
        rest: 'https://openapi.okx.com',
        publicWs: `wss://${host}/ws/v5/public`,
        privateWs: `wss://${host}/ws/v5/private`,
        businessWs: `wss://${host}/ws/v5/business`,
      }),
    ];
  }),
);
export function getOkxProfile(id: OkxProfileId): OkxEndpointProfile {
  const p = profiles.get(okxProfileIdSchema.parse(id));
  if (!p) throw new Error('INVALID_OKX_PROFILE');
  return p;
}
export function adapterProfile(
  endpoint: OkxEndpointProfile,
  credentialRef?: string,
): AdapterProfile {
  return immutable({
    ...endpoint.scope,
    accountMode: 'FUTURES_MODE_NET',
    profileVersion: 'v1',
    endpointProfileId: endpoint.id,
    ...(credentialRef === undefined ? {} : { credentialRef }),
  });
}
export const symbolSchema = z.string().regex(/^[A-Z0-9]{1,24}-USDT(?:-SWAP)?$/);
