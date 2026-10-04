import { nativeFeed } from './native-io.js';
import type { InstrumentRegistry } from '@ctp/exchange-core';
import type { PublicRatePort } from './ports.js';
/** Server composition only; no destinations, raw IO, credentials or private methods. */
export function createNativeTradeFeed(options: {
  registry: InstrumentRegistry;
  limiter: PublicRatePort;
  now?: () => number;
}) {
  if (
    !options ||
    Object.keys(options).some((k) => !['registry', 'limiter', 'now'].includes(k)) ||
    typeof options.registry?.get !== 'function' ||
    typeof options.limiter?.reserve !== 'function'
  )
    throw new Error('SERVER_PUBLIC_PORTS_REQUIRED');
  return nativeFeed(options);
}
