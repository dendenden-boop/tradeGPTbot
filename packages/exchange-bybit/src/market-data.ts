/** Read-only PHASE 9 integration. No private transport, credentials or mutations. */
export { normalizeTrade } from './public-data.js';
import { getBybitProfile, bybitProfileIdSchema } from './profiles.js';
export function publicMarketProfile(id: unknown) {
  return getBybitProfile(bybitProfileIdSchema.parse(id));
}
