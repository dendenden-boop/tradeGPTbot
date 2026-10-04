import { immutable, type AdapterProfile, type MarketScope } from '@ctp/exchange-core';
import { z } from 'zod';

export const bybitProfileIds = [
  'bybit-spot-live-v1',
  'bybit-spot-testnet-v1',
  'bybit-spot-demo-v1',
  'bybit-linear-live-v1',
  'bybit-linear-testnet-v1',
  'bybit-linear-demo-v1',
] as const;
export const bybitProfileIdSchema = z.enum(bybitProfileIds);
export type BybitProfileId = z.infer<typeof bybitProfileIdSchema>;
export interface BybitEndpointProfile {
  readonly id: BybitProfileId;
  readonly scope: MarketScope;
  readonly category: 'spot' | 'linear';
  readonly rest: string;
  readonly publicWs: string;
  readonly privateWs: string;
}
const profiles = new Map<BybitProfileId, BybitEndpointProfile>(
  bybitProfileIds.map((id) => {
    const category = id.includes('-spot-') ? ('spot' as const) : ('linear' as const);
    const environment = id.includes('-testnet-')
      ? ('TESTNET' as const)
      : id.includes('-demo-')
        ? ('DEMO' as const)
        : ('LIVE' as const);
    const domain =
      environment === 'TESTNET'
        ? 'api-testnet.bybit.com'
        : environment === 'DEMO'
          ? 'api-demo.bybit.com'
          : 'api.bybit.com';
    const stream = environment === 'TESTNET' ? 'stream-testnet.bybit.com' : 'stream.bybit.com';
    return [
      id,
      immutable({
        id,
        category,
        scope: {
          exchange: 'BYBIT' as const,
          region: 'global',
          market: category === 'spot' ? ('SPOT' as const) : ('LINEAR_PERPETUAL' as const),
          environment,
        },
        rest: `https://${domain}`,
        publicWs: `wss://${stream}/v5/public/${category}`,
        privateWs: `wss://${environment === 'DEMO' ? 'stream-demo.bybit.com' : stream}/v5/private`,
      }),
    ];
  }),
);
export function getBybitProfile(id: BybitProfileId): BybitEndpointProfile {
  const profile = profiles.get(bybitProfileIdSchema.parse(id));
  if (!profile) throw new Error('INVALID_BYBIT_PROFILE');
  return profile;
}
export function adapterProfile(
  endpoint: BybitEndpointProfile,
  credentialRef?: string,
): AdapterProfile {
  return immutable({
    ...endpoint.scope,
    accountMode: endpoint.category === 'spot' ? 'UTA2_SPOT' : 'UTA2_ONE_WAY',
    profileVersion: 'v1',
    endpointProfileId: endpoint.id,
    ...(credentialRef === undefined ? {} : { credentialRef }),
  });
}
export const symbolSchema = z.string().regex(/^[A-Z0-9]{2,32}$/);
