import { immutable, type AdapterProfile, type MarketScope } from '@ctp/exchange-core';
import { z } from 'zod';

export const binanceProfileIdSchema = z.enum([
  'binance-spot-live-v1',
  'binance-spot-testnet-v1',
  'binance-spot-demo-v1',
  'binance-usdm-live-v1',
  'binance-usdm-testnet-v1',
]);
export type BinanceProfileId = z.infer<typeof binanceProfileIdSchema>;
export interface BinanceEndpointProfile {
  readonly id: BinanceProfileId;
  readonly scope: MarketScope;
  readonly accountMode: string;
  readonly rest: string;
  readonly publicWs: string;
  readonly marketWs: string;
  readonly privateWs: string;
  readonly privateWsVerified: boolean;
}
const scope = (
  market: MarketScope['market'],
  environment: MarketScope['environment'],
): MarketScope => ({ exchange: 'BINANCE', region: 'global', market, environment });
const profiles: Readonly<Record<BinanceProfileId, BinanceEndpointProfile>> = immutable({
  'binance-spot-live-v1': {
    id: 'binance-spot-live-v1',
    scope: scope('SPOT', 'LIVE'),
    accountMode: 'SPOT',
    rest: 'https://api.binance.com',
    publicWs: 'wss://stream.binance.com:443',
    marketWs: 'wss://stream.binance.com:443',
    privateWs: 'wss://ws-api.binance.com:443/ws-api/v3',
    privateWsVerified: true,
  },
  'binance-spot-testnet-v1': {
    id: 'binance-spot-testnet-v1',
    scope: scope('SPOT', 'TESTNET'),
    accountMode: 'SPOT',
    rest: 'https://testnet.binance.vision',
    publicWs: 'wss://stream.testnet.binance.vision',
    marketWs: 'wss://stream.testnet.binance.vision',
    privateWs: 'wss://ws-api.testnet.binance.vision/ws-api/v3',
    privateWsVerified: true,
  },
  'binance-spot-demo-v1': {
    id: 'binance-spot-demo-v1',
    scope: scope('SPOT', 'DEMO'),
    accountMode: 'SPOT',
    rest: 'https://demo-api.binance.com',
    publicWs: 'wss://demo-stream.binance.com',
    marketWs: 'wss://demo-stream.binance.com',
    privateWs: 'wss://demo-ws-api.binance.com/ws-api/v3',
    privateWsVerified: true,
  },
  'binance-usdm-live-v1': {
    id: 'binance-usdm-live-v1',
    scope: scope('LINEAR_PERPETUAL', 'LIVE'),
    accountMode: 'ONE_WAY',
    rest: 'https://fapi.binance.com',
    publicWs: 'wss://fstream.binance.com/public',
    marketWs: 'wss://fstream.binance.com/market',
    privateWs: 'wss://fstream.binance.com/private',
    privateWsVerified: true,
  },
  'binance-usdm-testnet-v1': {
    id: 'binance-usdm-testnet-v1',
    scope: scope('LINEAR_PERPETUAL', 'TESTNET'),
    accountMode: 'ONE_WAY',
    rest: 'https://demo-fapi.binance.com',
    publicWs: 'wss://demo-fstream.binance.com/public',
    marketWs: 'wss://demo-fstream.binance.com/market',
    privateWs: 'wss://demo-fstream.binance.com/private',
    privateWsVerified: false,
  },
});
export function getBinanceProfile(value: unknown): BinanceEndpointProfile {
  const parsed = binanceProfileIdSchema.safeParse(value);
  if (!parsed.success) throw new Error('INVALID_BINANCE_PROFILE');
  return profiles[parsed.data];
}
export function adapterProfile(
  endpoint: BinanceEndpointProfile,
  credentialRef?: string,
): AdapterProfile {
  return immutable({
    ...endpoint.scope,
    accountMode: endpoint.accountMode,
    profileVersion: 'binance-contract-v1',
    endpointProfileId: endpoint.id,
    ...(credentialRef === undefined ? {} : { credentialRef }),
  });
}
export const symbolSchema = z.string().regex(/^[A-Z0-9]{2,32}$/);
export function publicStreamUrl(
  endpoint: BinanceEndpointProfile,
  symbol: string,
  stream: string,
  book = false,
): URL {
  symbolSchema.parse(symbol);
  if (
    !/^(?:ticker|aggTrade|depth(?:5|10|20)@100ms|kline_(?:1m|3m|5m|15m|30m|1h|4h|1d))$/.test(stream)
  )
    throw new Error('INVALID_BINANCE_STREAM');
  const base = book ? endpoint.publicWs : endpoint.marketWs;
  // Combined is documented for Spot Testnet; use it consistently on all Spot profiles.
  return new URL(
    endpoint.scope.market === 'SPOT'
      ? `${base}/stream?streams=${symbol.toLowerCase()}@${stream}`
      : `${base}/ws/${symbol.toLowerCase()}@${stream}`,
  );
}
