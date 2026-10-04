/** Read-only PHASE 9 integration. No private transport, credentials or mutations. */
export { normalizeTrade } from './public-data.js';
import { getOkxProfile, okxProfileIdSchema } from './profiles.js';
export function publicMarketProfile(id: unknown) {
  return getOkxProfile(okxProfileIdSchema.parse(id));
}
