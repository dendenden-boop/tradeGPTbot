/** Read-only PHASE 9 integration. No private transport, credentials or mutations. */
export { normalizeTrade } from './public-data.js';
import { getHtxProfile, htxProfileIdSchema } from './profiles.js';
export function publicMarketProfile(id: unknown) {
  return getHtxProfile(htxProfileIdSchema.parse(id));
}
